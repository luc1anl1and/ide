// Chat: one pane per conversation; agents (claude/codex/opencode) share one event protocol
(function () {
  marked.setOptions({ gfm: true, breaks: false });

  const TOOL_ICON = { Bash: 'term', PowerShell: 'term', Read: 'eye', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', ApplyPatch: 'edit', NotebookEdit: 'edit', Glob: 'search', Grep: 'search', WebFetch: 'globe', WebSearch: 'globe', TodoWrite: 'list', Task: 'sparkle', Agent: 'sparkle', AskUserQuestion: 'help', ExitPlanMode: 'task' };
  const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

  function toolSummary(name, inp) {
    inp = inp || {};
    const v = inp.command || inp.file_path || inp.notebook_path || inp.pattern || inp.url || inp.query || inp.description || inp.prompt;
    if (name === 'TodoWrite') return (inp.todos || []).length + ' items';
    if (v) { const s = String(v).split('\n')[0].slice(0, 200); return (inp.file_path || inp.notebook_path) === v ? relp(s) : s; }
    const first = Object.values(inp).find((x) => typeof x === 'string');
    return first ? first.slice(0, 120) : '';
  }
  function prettyName(n) {
    if (n.startsWith('mcp__')) { const p = n.split('__'); return p[1].replace(/^claude_ai_/, '') + ' › ' + p.slice(2).join('__'); }
    return n;
  }

  // ---------- markdown ----------
  function renderMd(el, text, colorize) {
    el.classList.add('md');
    el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });
    enhance(el, colorize);
  }
  function enhance(el, colorize) {
    $$('pre', el).forEach((pre) => {
      if (pre.parentElement.classList.contains('codeblk')) return;
      const code = pre.querySelector('code') || pre;
      const lang = ((code.className || '').match(/language-([\w+-]+)/) || [])[1] || '';
      const wrap = h('div', { class: 'codeblk' });
      const head = h('div', { class: 'ch' }, h('span', null, lang || 'text'),
        h('button', { class: 'icon-btn sm', title: 'Copy', html: icon('copy'), onclick: () => { navigator.clipboard.writeText(code.textContent); toast('Copied'); } }));
      pre.replaceWith(wrap); wrap.append(head, pre);
      if (colorize && lang && window.monaco && monaco.editor && monaco.editor.colorize) {
        monaco.editor.colorize(code.textContent, lang, { tabSize: 2 }).then((html) => { code.innerHTML = html; code.style.fontFamily = 'var(--mono)'; }).catch(() => { });
      }
    });
    $$('a', el).forEach((a) => {
      const href = a.getAttribute('href') || '';
      a.addEventListener('click', (e) => { e.preventDefault(); if (/^https?:/.test(href)) api.fs.openExternal(href); else openPathFromChat(decodeURIComponent(href)); });
    });
    $$('code', el).forEach((c) => {
      if (c.parentElement.tagName === 'PRE') return;
      const t = c.textContent.trim();
      if (/^[\w.\\/~-]+\.\w{1,8}(:\d+)?$/.test(t) && !t.startsWith('http')) { c.style.cursor = 'pointer'; c.title = 'Open in editor'; c.addEventListener('click', () => openPathFromChat(t)); }
    });
  }
  function openPathFromChat(p) {
    let line = 0; const m = p.match(/^(.*):(\d+)$/); if (m) { p = m[1]; line = +m[2]; }
    if (!/^[a-zA-Z]:[\\/]/.test(p)) p = A.ws ? joinp(A.ws, p.replace(/\//g, '\\')) : p;
    window.openFile && window.openFile(p, line);
  }
  window.renderMd = renderMd;

  // ---------- chat objects ----------
  const chats = A.chats;
  let tabsEl, tabsWrap, paneHost;
  const agentCfg = (p) => ((A.settings.agentCfg || {})[p]) || {};
  const cfgSig = (c) => JSON.stringify([c.cwd || A.ws, c.cfg, agentCfg(c.cfg.provider), customPath(c.cfg.provider), A.keysRev || 0]);

  function buildChatPanel() {
    const root = $('#chat');
    tabsEl = h('div', { class: 'scroller' });
    tabsWrap = TabScroll(tabsEl, { list: () => chats.map((x) => ({ value: x.id, label: x.title, sub: PROV[x.cfg.provider].name + (x.running ? ' · working…' : x.pendingPerms ? ' · needs approval' : ''), icon: PROV[x.cfg.provider].logo, on: x === A.activeChat })), onPick: (id) => selectChat(chats.find((x) => x.id === id)) });
    const head = h('div', { class: 'chat-tabs' }, h('button', { class: 'icon-btn focus-only', title: 'Show / hide chat list (Ctrl+B)', html: icon('panelLeft'), onclick: () => App.toggleSide() }), tabsWrap,
      tabsWrap.listButton('All chats'),
      h('button', { class: 'icon-btn', title: 'Undo last message', html: icon('undo'), onclick: () => { const c = A.activeChat; if (c && c.turns.length) undoTo(c, c.turns.length - 1); else toast('Nothing to undo'); } }),
      h('button', { class: 'icon-btn', title: 'Copy chat as Markdown', html: icon('copy'), onclick: () => exportChat() }),
      h('button', { class: 'icon-btn', title: 'New chat (Ctrl+Shift+N)', html: icon('plus'), onclick: () => newChat() }));
    paneHost = h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } });
    root.append(head, paneHost);
  }
  function exportChat() {
    const c = A.activeChat; if (!c) return;
    const md = c.transcript.map((m) => (m.role === 'user' ? '## You\n\n' : '## ' + PROV[c.cfg.provider].name + '\n\n') + m.text).join('\n\n');
    navigator.clipboard.writeText(md); toast('Chat copied as Markdown');
  }

  function newChat(opts = {}) {
    const provider = opts.provider || A.settings.provider || 'claude';
    const c = {
      id: uuid(), revaId: opts.revaId || null, events: [], created: Date.now(), sessionId: null, resumeId: opts.resume || null, cwd: opts.cwd || null, title: opts.title || 'New chat', transcript: [],
      turns: [], tasks: new Map(), running: false, started: false, sig: '', cost: 0, model: '', commands: [], atts: [], tools: {}, msgs_by: {}, tokens: null,
      cfg: Prov.defaultCfg(provider), pendingPerms: 0,
    };
    buildPane(c);
    chats.push(c);
    selectChat(c);
    if (opts.resume || opts.revaId) loadHistory(c, opts.revaId);
    return c;
  }

  function buildPane(c) {
    const msgs = h('div', { class: 'msgs selectable' });
    const ta = h('textarea', { rows: 1, placeholder: 'Message…   ( / for commands )' });
    const attach = h('div', { class: 'attach hidden' });
    const sendBtn = h('button', { class: 'send', title: 'Send', html: icon('send') });
    const plusBtn = h('button', { class: 'icon-btn', title: 'Attach image, audio, video or file', html: icon('plus') });
    const micBtn = h('button', { class: 'icon-btn', title: 'Voice message', html: icon('mic') });
    const modelChip = h('button', { class: 'cchip', title: 'Model' });
    const ctxChip = h('button', { class: 'cchip ctx-chip hidden', title: 'Your agent automatically sees the file you have open. Click to leave it out of the next message.', onclick: () => { c.ctxOff = !c.ctxOff; updateCtxChip(c); } });
    const ac = h('div', { class: 'ac hidden' });
    const cbox = h('div', { class: 'cbox' }, attach, ta, h('div', { class: 'cbar' }, plusBtn, micBtn, ctxChip, h('span', { class: 'sp' }), modelChip, sendBtn));
    const composer = h('div', { class: 'composer' }, ac, cbox, h('div', { class: 'hint' }, h('span', null, 'Drop images, audio, video or files here'), h('span', { class: 'ctx' }, '')));
    const pane = h('div', { class: 'chat-pane hidden' }, msgs, composer);
    Object.assign(c, { pane, msgs, ta, attach, sendBtn, ac, micBtn, plusBtn, ctxChip, modelChip, ctxEl: $('.ctx', composer) });
    renderEmpty(c); updateChip(c); updateCtxChip(c);

    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 240) + 'px'; };
    ta.addEventListener('input', () => { grow(); updateAc(c); if (c.running) { sendBtn.classList.toggle('stop', !ta.value.trim() && !c.atts.length); sendBtn.innerHTML = icon(ta.value.trim() || c.atts.length ? 'send' : 'stop'); } });
    ta.addEventListener('keydown', (e) => {
      if (!ac.classList.contains('hidden')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveAc(c, e.key === 'ArrowDown' ? 1 : -1); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickAc(c); return; }
        if (e.key === 'Escape') { ac.classList.add('hidden'); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(c); }
      if (e.key === 'Escape') { if (c.rec) cancelRec(c); else if (c.running) interrupt(c); }
      if (e.key === 'ArrowUp' && !ta.value && c.history && c.history.length) { ta.value = c.history[c.history.length - 1]; grow(); }
    });
    sendBtn.addEventListener('click', () => (c.running && !ta.value.trim() && !c.atts.length ? interrupt(c) : submit(c)));
    plusBtn.addEventListener('click', () => Combo.open(plusBtn, { title: 'Attach', width: 270, onPick: (v) => attachPick(c, v), items: [
      { value: 'image', label: 'Image or file', sub: 'Screenshots, photos, documents', icon: icon('image') },
      { value: 'media', label: 'Audio or video', sub: 'Transcribed locally with Whisper', icon: icon('film') },
      { value: 'clip', label: 'Paste image from clipboard', icon: icon('copy') }] }));
    micBtn.addEventListener('click', () => (c.rec ? stopRec(c) : startRec(c)));
    micBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); voiceLangMenu(c); });
    modelChip.addEventListener('click', () => { const b = $('#tb-combos .cbtn:nth-child(2)'); b && b.click(); });
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); files.forEach((f) => addFile(c, f)); }
    });
    cbox.addEventListener('dragover', (e) => { e.preventDefault(); cbox.classList.add('drop'); });
    cbox.addEventListener('dragleave', () => cbox.classList.remove('drop'));
    const onDrop = (e) => {
      e.preventDefault(); cbox.classList.remove('drop');
      const p = e.dataTransfer.getData('text/reva-path'); if (p) { insertText(c, '@' + relp(p) + ' '); return; }
      for (const f of e.dataTransfer.files) addFile(c, f);
    };
    cbox.addEventListener('drop', onDrop);
    msgs.addEventListener('dragover', (e) => e.preventDefault()); msgs.addEventListener('drop', onDrop);
    paneHost.append(pane);
  }
  // the file open in the editor is shared with the agent automatically (chip shows it; click to exclude it from the next message)
  function updateCtxChip(c) {
    if (!c.ctxChip) return; const cx = A.settings.shareOpenFile !== false && window.getEditorContext ? getEditorContext() : null;
    c.ctxChip.classList.toggle('hidden', !cx); if (!cx) return;
    c.ctxChip.classList.toggle('off', !!c.ctxOff);
    c.ctxChip.innerHTML = icon('file') + '<span>' + esc(basename(cx.path)) + (cx.selection ? ' · selection' : '') + '</span>';
  }
  function buildCtx(c, cx) {
    const key = cx.path + ':' + cx.size + ':' + cx.text.length + ':' + cx.text.slice(0, 64) + cx.text.slice(-64); const same = c.lastCtx === key; c.lastCtx = key;
    const F = '```'; // markdown fence
    const where = '`' + cx.rel + '` (' + cx.language + ', cursor on line ' + cx.line + (cx.dirty ? ', unsaved edits included' : '') + ')';
    let out = '';
    if (same && !cx.selection) out = '\n\n[Editor: the user still has ' + where + ' open and unchanged since your last look.]';
    else if (cx.size <= 24000) out = '\n\n[Editor context — the user has ' + where + ' open. Its full current contents:]\n' + F + cx.language + '\n' + cx.text + '\n' + F;
    else out = '\n\n[Editor context — the user has ' + where + ' open; it is ' + cx.size + ' characters, too large to paste here. Read the whole file with your tools before answering anything about it.]';
    if (cx.selection) out += '\n[The user has selected lines ' + cx.selStart + '–' + cx.selEnd + ':]\n' + F + '\n' + cx.selection + '\n' + F;
    return out;
  }
  function updateChip(c) {
    const P = PROV[c.cfg.provider];
    c.modelChip.innerHTML = `<span style="display:grid">${P.logo}</span><span>${esc(Prov.modelLabel(c.cfg.provider, c.cfg.model))}</span>`;
    c.modelChip.firstChild.firstChild.setAttribute('width', 14); c.modelChip.firstChild.firstChild.setAttribute('height', 14);
  }

  function renderEmpty(c) {
    c.msgs.innerHTML = '';
    const P = PROV[c.cfg.provider]; const st = Prov.status(c.cfg.provider);
    if (st.state === 'missing' || st.state === 'login') {
      c.emptyEl = h('div', { class: 'chat-empty', style: { maxWidth: '420px', width: '100%' } }, Setup.card(c.cfg.provider, () => { Bar.render(); if (Setup.ready(c.cfg.provider)) renderEmpty(c); }));
    } else {
      const sugg = ['Explain this project structure', 'Find and fix bugs in the open file', 'Write tests for the current file', 'Review my recent changes'];
      c.emptyEl = h('div', { class: 'chat-empty' }, h('div', { class: 'pl', html: P.logo }), h('h3', null, 'What are we building?'),
        h('div', null, A.ws ? basename(A.ws) + ' · ' + P.name : 'Open a folder to give ' + P.name + ' a workspace'),
        h('div', { class: 'sugg' }, sugg.map((s) => h('button', { onclick: () => { c.ta.value = s; c.ta.focus(); } }, s))));
    }
    c.msgs.append(c.emptyEl);
  }

  function selectChat(c) {
    A.activeChat = c;
    chats.forEach((x) => x.pane.classList.toggle('hidden', x !== c));
    renderTabs(); Bar.render(); updateStatus();
    setTimeout(() => c.ta.focus(), 30);
  }
  function renderTabs() {
    window.AgentsPanel && AgentsPanel.touch(); window.PetBridge && PetBridge.sync();
    tabsEl.innerHTML = '';
    chats.forEach((c) => tabsEl.append(h('div', { class: 'ctab' + (c === A.activeChat ? ' on' : ''), onclick: () => selectChat(c), title: c.title },
      h('span', { class: 'pv' + (c.running ? ' alive' : ''), html: PROV[c.cfg.provider].logo }),
      h('span', { class: 't' }, c.title + (c.pendingPerms ? ' •' : '')),
      h('span', { class: 'x', html: icon('x'), onclick: (e) => { e.stopPropagation(); closeChat(c); } }))));
    const on = tabsEl.querySelector('.ctab.on'); if (on) tabsWrap.reveal(on);
  }
  function closeChat(c) {
    api.agent.kill(c.id); c.pane.remove();
    const i = chats.indexOf(c); chats.splice(i, 1);
    if (!chats.length) newChat(); else if (A.activeChat === c) selectChat(chats[Math.max(0, i - 1)]); else renderTabs();
  }

  // ---------- attachments ----------
  function insertText(c, t) {
    const ta = c.ta; const s = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + t + ta.value.slice(ta.selectionEnd ?? s);
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + t.length; ta.dispatchEvent(new Event('input'));
  }
  async function attachPick(c, v) {
    if (v === 'image') {
      const files = await api.dialog.images();
      for (const f of files) { if (f.isImage) addImage(c, { name: f.name, mediaType: f.mediaType, data: f.data }); else insertText(c, '@' + relp(f.path) + ' '); }
    } else if (v === 'media') {
      const paths = await api.dialog.media();
      for (const p of paths) { const k = Media.kindOf(p); if (k === 'image') { const f = await api.fs.readB64(p); addImage(c, { name: f.name, mediaType: f.mediaType, data: f.data }); } else addMedia(c, await Media.attachPath(p)); }
    } else if (v === 'clip') {
      const im = await api.clipboard.readImage(); if (im) addImage(c, im); else toast('No image on the clipboard', true);
    }
  }
  function addFile(c, f) {
    const k = Media.kindOf(f.name || '', f.type);
    if (k === 'image') { const r = new FileReader(); r.onload = async () => { addImage(c, { name: f.name || 'image', ...(await shrink(String(r.result))) }); }; r.readAsDataURL(f); }
    else if (k === 'audio' || k === 'video') addMedia(c, Media.attach(f, f.name || 'media'));
    else { const fp = api.fs.pathOf(f); if (fp) insertText(c, '@' + relp(fp) + ' '); }
  }
  function shrink(dataUrl) {
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const mt = dataUrl.slice(5, dataUrl.indexOf(';'));
        const big = dataUrl.length > 4_500_000 || Math.max(im.width, im.height) > 3000;
        if (!big || mt === 'image/gif') return res({ mediaType: mt, data: dataUrl.split(',')[1] });
        const k = Math.min(1, 2400 / Math.max(im.width, im.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        res({ mediaType: 'image/jpeg', data: cv.toDataURL('image/jpeg', 0.88).split(',')[1] });
      };
      im.onerror = () => res({ mediaType: dataUrl.slice(5, dataUrl.indexOf(';')), data: dataUrl.split(',')[1] });
      im.src = dataUrl;
    });
  }
  function addImage(c, img) { c.atts.push({ kind: 'image', status: 'ready', ...img }); renderAttach(c); }
  function addMedia(c, att) {
    att.onUpdate = () => renderAttach(c); c.atts.push(att); renderAttach(c);
    return att;
  }
  function renderAttach(c) {
    c.attach.innerHTML = ''; c.attach.classList.toggle('hidden', !c.atts.length);
    c.atts.forEach((a, i) => {
      const rm = h('span', { class: 'rm', onclick: (e) => { e.stopPropagation(); c.atts.splice(i, 1); renderAttach(c); } }, '×');
      if (a.kind === 'image') { c.attach.append(h('div', { class: 'att img', title: a.name }, h('img', { src: `data:${a.mediaType};base64,${a.data}` }), rm)); return; }
      const prog = a.progress && a.progress.phase === 'download' ? `Model ${Math.round(a.progress.pct || 0)}%` : a.stage;
      const sub = a.status === 'working' ? [h('span', { class: 'spin' }), prog || 'Working…'] : a.status === 'error' ? [h('span', { style: { color: 'var(--bad)' } }, 'Failed')] : [Media.fmtDur(a.duration) + (a.kind === 'video' ? ` · ${a.frames.length} frames` : ''), a.language ? ' · ' + a.language : ''];
      c.attach.append(h('div', { class: 'att media', title: a.error || a.name, onclick: () => openTranscript(c, a) },
        h('span', { class: 'am-ico', html: icon(a.kind === 'video' ? 'film' : a.kind === 'voice' ? 'mic' : 'music') }),
        h('div', { class: 'am-t' }, h('b', null, a.kind === 'voice' ? 'Voice message' : a.name), h('span', null, ...sub)), rm));
    });
  }
  function openTranscript(c, a) {
    if (a.status === 'working') return;
    const ta = h('textarea', { class: 'inp', rows: 8, style: { width: '100%' } }); ta.value = a.error ? 'Error: ' + a.error : a.transcript;
    const player = a.kind === 'video' ? h('video', { src: a.url, controls: true, style: { width: '100%', borderRadius: '10px', marginBottom: '10px', maxHeight: '240px' } }) : h('audio', { src: a.url, controls: true, style: { width: '100%', marginBottom: '10px' } });
    const frames = a.frames && a.frames.length ? h('div', { style: { display: 'flex', gap: '5px', overflowX: 'auto', margin: '0 0 10px' } }, a.frames.map((f) => h('img', { src: `data:image/jpeg;base64,${f.data}`, style: { height: '54px', borderRadius: '6px' } }))) : null;
    const m = openModal([h('div', { class: 'mh' }, a.kind === 'voice' ? 'Voice message' : a.name), h('div', { class: 'mb' }, player, frames, h('div', { class: 'field' }, h('label', null, 'Transcript (editable — this is what the AI receives)'), ta)),
      h('div', { class: 'mf' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => { if (!a.error) a.transcript = ta.value; m.close(); } }, 'Save'))]);
  }
  // ---------- dictation: live transcript while you speak, full-accuracy pass when you stop ----------
  async function startRec(c) {
    try {
      const bars = h('span', { class: 'rec-wave' }, h('i'), h('i'), h('i'), h('i'), h('i'));
      c.liveEl = h('div', { class: 'live-tx' }, h('div', { class: 'lt-h' }, h('span', { class: 'lt-dot' }), h('span', { class: 'lt-s' }, 'Listening…'), h('span', { class: 'lt-t' }, '0:00')), h('div', { class: 'lt-b' }, h('span', { class: 'lt-ph' }, 'Start speaking — the words appear here as you talk')));
      c.pane.querySelector('.composer').insertBefore(c.liveEl, $('.cbox', c.pane));
      c.rec = await Media.recordPcm((lv) => { const kids = c.micBtn.querySelectorAll('.rec-wave i'); kids.forEach((k, i) => (k.style.height = Math.max(25, Math.min(100, lv * 100 * (0.6 + ((i * 37) % 5) / 6))) + '%')); });
      c.micBtn.classList.add('rec'); c.micBtn.title = 'Stop dictation'; c.micBtn.innerHTML = ''; c.micBtn.append(bars);
      const t0 = Date.now(); c.recTimer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); const el = $('.lt-t', c.liveEl); if (el) el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }, 500);
      if (A.settings.voice.live !== false) liveLoop(c);
    } catch (e) { toast('Microphone unavailable: ' + (e.message || e), true); stopLive(c); c.rec = null; }
  }
  // transcribe the growing recording every couple of seconds; windows are committed every ~24 s so it stays fast
  function liveLoop(c) {
    const st = { committed: '', winStart: 0, busy: false, dl: null };
    const off = api.on('voice:progress', (p) => { if (p.phase === 'download' && c.liveEl) { const s = $('.lt-s', c.liveEl); if (s) s.textContent = 'Downloading speech model… ' + Math.round(p.pct || 0) + '%'; } });
    const paint = (txt) => { const b = $('.lt-b', c.liveEl); if (!b) return; const full = (st.committed + ' ' + txt).trim(); b.textContent = full || ''; if (!full) b.append(h('span', { class: 'lt-ph' }, 'Listening for speech…')); b.scrollTop = b.scrollHeight; };
    const tick = async () => {
      if (st.busy || !c.rec) return; const pcm = c.rec.pcm(); const slice = pcm.subarray(st.winStart);
      if (slice.length < 16000 * 1.5) return; st.busy = true;
      try {
        const r = await Media.transcribeQuick(slice.slice());
        if (!c.rec) return; const s = $('.lt-s', c.liveEl); if (s) s.textContent = 'Listening…' + (r.language ? ' · ' + r.language : '');
        paint((r.text || '').trim());
        if (slice.length > 16000 * 24) { st.committed = (st.committed + ' ' + (r.text || '')).trim(); st.winStart = pcm.length; }
        c.liveText = (st.committed + ' ' + (slice.length > 16000 * 24 ? '' : (r.text || ''))).trim();
      } catch (e) { const s = $('.lt-s', c.liveEl); if (s) s.textContent = 'Live preview unavailable — final transcript will still work'; }
      finally { st.busy = false; }
    };
    c.liveTimer = setInterval(tick, 2200); c.liveOff = off; tick();
  }
  function stopLive(c) {
    clearInterval(c.recTimer); clearInterval(c.liveTimer); c.liveOff && c.liveOff(); c.liveOff = null;
    if (c.liveEl) { c.liveEl.remove(); c.liveEl = null; }
  }
  function resetMic(c) { stopLive(c); c.rec = null; c.liveText = ''; c.micBtn.classList.remove('rec'); c.micBtn.innerHTML = icon('mic'); c.micBtn.title = 'Voice message · right-click for microphone & language'; c.ctxEl.textContent = ''; }
  function cancelRec(c) { if (!c.rec) return; c.rec.cancel(); resetMic(c); }
  async function stopRec(c) {
    const rec = c.rec; if (!rec) return; const dur = rec.elapsed(); const pcm = rec.stop();
    // keep the live panel up while the accurate final pass runs
    clearInterval(c.recTimer); clearInterval(c.liveTimer); c.liveOff && c.liveOff();
    c.micBtn.classList.remove('rec'); c.micBtn.innerHTML = icon('mic'); c.rec = null;
    if (dur < 0.4) { resetMic(c); return; }
    if (c.liveEl) { const s = $('.lt-s', c.liveEl); if (s) s.textContent = 'Finalizing…'; }
    const att = Media.attachPcm(pcm, 'voice-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.wav', { voice: true });
    att.onUpdate = () => { if (c.liveEl && att.progress && att.progress.phase === 'download') { const s = $('.lt-s', c.liveEl); if (s) s.textContent = 'Downloading speech model… ' + Math.round(att.progress.pct || 0) + '%'; } };
    await att.promise; c.liveText = '';
    stopLive(c); resetMic(c);
    if (att.status === 'error') { toast('Transcription failed: ' + att.error, true); return; }
    if (!att.transcript) { toast('No speech detected', true); return; }
    addMedia(c, att); // chip with the audio for replay; its text goes into the box below
    const sep = c.ta.value && !/\s$/.test(c.ta.value) ? ' ' : '';
    insertText(c, sep + att.transcript); att.inserted = true; renderAttach(c);
    if (A.settings.voice && A.settings.voice.autoSend) submit(c);
  }
  const VOICE_LANGS = [['auto', 'Auto-detect'], ['ro', 'Romanian'], ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['hu', 'Hungarian'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['ko', 'Korean']];
  window.VOICE_LANGS = VOICE_LANGS;
  async function voiceLangMenu(c) {
    const devs = await Media.devices(); const v = A.settings.voice;
    const items = [...devs.map((d) => ({ value: 'dev:' + d.id, label: d.label, icon: icon('mic'), group: 'Microphone' })), ...VOICE_LANGS.map(([k, l]) => ({ value: 'lang:' + k, label: l, group: 'Speech language' }))];
    Combo.open(c.micBtn, { title: 'Voice input', width: 320, search: true, value: 'dev:' + (v.deviceId || 'default'), items, onPick: (val) => {
      if (val.startsWith('dev:')) { v.deviceId = val.slice(4); toast('Microphone: ' + (devs.find((d) => d.id === v.deviceId) || {}).label); }
      else { v.language = val.slice(5); toast('Speech language: ' + (VOICE_LANGS.find((x) => x[0] === v.language) || [])[1]); }
      saveSettings();
    } });
  }

  // slash command autocomplete
  function updateAc(c) {
    const v = c.ta.value;
    if (!v.startsWith('/') || v.includes('\n') || v.includes(' ')) { c.ac.classList.add('hidden'); return; }
    const q = v.slice(1).toLowerCase();
    const list = (c.commands || []).concat(window.RevaPlugins ? RevaPlugins.slashCommands() : []).filter((x) => x.name.toLowerCase().includes(q)).slice(0, 40);
    if (!list.length) { c.ac.classList.add('hidden'); return; }
    c.acList = list; c.acIdx = 0; c.ac.innerHTML = '';
    list.forEach((x, i) => c.ac.append(h('div', { class: 'it' + (i === 0 ? ' on' : ''), onmousedown: (e) => { e.preventDefault(); c.acIdx = i; pickAc(c); } }, h('b', null, '/' + x.name), h('span', null, x.description || ''))));
    c.ac.classList.remove('hidden');
  }
  function moveAc(c, d) { c.acIdx = (c.acIdx + d + c.acList.length) % c.acList.length; $$('.it', c.ac).forEach((e, i) => { e.classList.toggle('on', i === c.acIdx); if (i === c.acIdx) e.scrollIntoView({ block: 'nearest' }); }); }
  function pickAc(c) { const x = c.acList[c.acIdx]; c.ta.value = '/' + x.name + ' '; c.ac.classList.add('hidden'); c.ta.focus(); c.ta.dispatchEvent(new Event('input')); }

  // ---------- process control ----------
  async function ensureProc(c) {
    const sig = cfgSig(c);
    if (c.started && sig !== c.sig && !c.running) { await api.agent.kill(c.id); c.started = false; c.resumeId = c.sessionId || c.resumeId; }
    if (c.started) return true;
    const r = await api.agent.start({
      id: c.id, provider: c.cfg.provider, cwd: c.cwd || A.ws, model: c.cfg.model, effort: c.cfg.effort, mode: c.cfg.mode, resume: c.resumeId || c.sessionId,
      instructions: c.cfg.provider === 'claude' ? agentCfg('claude').instructions : '', addDirs: agentCfg(c.cfg.provider).dirs || [], flags: agentCfg(c.cfg.provider).flags || '', custom: customPath(c.cfg.provider),
    });
    if (!r.ok) { sysLine(c, 'Could not start ' + PROV[c.cfg.provider].name + ': ' + r.error, true); return false; }
    c.started = true; c.sig = sig; c.ideHint = r.ideHint || ''; return true;
  }
  async function submit(c) {
    if (window.RevaPlugins) { const t = await RevaPlugins.beforeSend(c.ta.value, c); if (t === false) { c.ta.value = ''; c.ac.classList.add('hidden'); return; } c.ta.value = t; }
    const text = c.ta.value.trim();
    if (!text && !c.atts.length) return;
    const st = Prov.status(c.cfg.provider);
    if (st.state === 'missing' || st.state === 'login') { toast(PROV[c.cfg.provider].name + ': ' + (st.state === 'missing' ? 'not installed' : 'sign-in required'), true); return; }
    if (c.atts.some((a) => a.status === 'working')) { toast('Waiting for transcription…'); await Promise.all(c.atts.map((a) => a.promise || a)); }
    const bad = c.atts.find((a) => a.status === 'error'); if (bad) { toast(bad.name + ': ' + bad.error, true); c.atts = c.atts.filter((a) => a !== bad); renderAttach(c); return; }
    if (!(await ensureProc(c))) return;
    const atts = c.atts.slice(); c.atts = [];
    const images = [];
    atts.forEach((a) => { if (a.kind === 'image') images.push(a); else if (a.kind === 'video') a.frames.forEach((f) => images.push(f)); });
    const extra = Media.promptBlocks(atts.filter((a) => a.kind !== 'image'));
    let full = [text, extra].filter(Boolean).join('\n\n'); const storedText = full;
    let sharedFile = null; if (A.settings.shareOpenFile !== false && !c.ctxOff && window.getEditorContext) { const cx = getEditorContext(); if (cx) { full += buildCtx(c, cx); sharedFile = cx.rel; } } c.ctxOff = false; updateCtxChip(c);
    // agents without a system-prompt flag get the user's instructions prepended to the first message of a new session
    const instr = ((agentCfg(c.cfg.provider).instructions || '').trim() + (c.ideHint ? '\n\n' + c.ideHint : '')).trim();
    if (instr && c.cfg.provider !== 'claude' && !c.instrSent && !c.resumeId && c.turns.length === 0) { c.instrSent = true; full = `[Standing instructions from the user — follow them for this whole conversation]\n${instr}\n\n---\n\n${full}`; }
    c.ta.value = ''; c.ta.style.height = 'auto'; renderAttach(c); c.ac.classList.add('hidden');
    (c.history = c.history || []).push(text);
    const cpm = await api.cp.mark().catch(() => null); // checkpoint so Undo can restore files whatever tool the agent used
    userMsg(c, text, images.filter((i) => i.kind === 'image'), [...atts.filter((a) => a.kind !== 'image'), ...(sharedFile ? [{ kind: 'file', name: sharedFile }] : [])]);
    if (cpm) c.turns[c.turns.length - 1].mark = cpm.t;
    c.transcript.push({ role: 'user', text: full });
    c.events.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: storedText }] } });
    if (c.title === 'New chat') { c.title = (text || (atts[0] && atts[0].name) || 'Chat').replace(/\s+/g, ' ').slice(0, 30); renderTabs(); }
    const content = images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } }));
    if (full) content.push({ type: 'text', text: full });
    api.agent.write({ id: c.id, obj: { type: 'user', message: { role: 'user', content } } });
    setRunning(c, true);
  }
  function interrupt(c) {
    // pressing Stop while an approval card is open = decline it (otherwise the agent would sit waiting forever)
    if (c.perms) [...c.perms].forEach((p) => p.deny());
    api.agent.write({ id: c.id, obj: { type: 'control_request', request_id: uuid(), request: { subtype: 'interrupt' } } });
    setTimeout(() => { if (c.running) { api.agent.kill(c.id); c.started = false; setRunning(c, false); sysLine(c, 'Stopped.'); } }, 3500);
  }
  function setRunning(c, v) {
    c.running = v; c._phase = v ? 'thinking' : null; c.sendBtn.classList.toggle('stop', v && !c.ta.value.trim() && !c.atts.length);
    c.sendBtn.innerHTML = icon(v && !c.ta.value.trim() && !c.atts.length ? 'stop' : 'send');
    if (v) showTyping(c); else hideTyping(c);
    renderTabs(); updateStatus();
    const ai = document.querySelector('#tb-combos .cbtn .cb-ico'); if (ai && c === A.activeChat) ai.classList.toggle('alive', v);
    if (window.petHook) window.petHook(c, v);
  }

  // ---------- rendering ----------
  function scrollDown(c, force) { const m = c.msgs; if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight; }
  function clearEmpty(c) { if (c.emptyEl) { c.emptyEl.remove(); c.emptyEl = null; } }
  function sysLine(c, t, err) { clearEmpty(c); c.msgs.append(h('div', { class: 'sysline' + (err ? ' err' : '') }, t)); scrollDown(c, true); }
  function userMsg(c, text, images, atts) {
    clearEmpty(c);
    const el = h('div', { class: 'msg user' });
    if (images && images.length) el.append(h('div', { class: 'imgs' }, images.map((im) => h('img', { src: `data:${im.mediaType};base64,${im.data}`, onclick: (e) => lightbox(e.target.src) }))));
    if (atts && atts.length) el.append(h('div', { class: 'chips' }, atts.map((a) => h('span', { class: 'chip2' }, h('span', { class: 'ico', html: icon(a.kind === 'video' ? 'film' : a.kind === 'voice' ? 'mic' : a.kind === 'file' ? 'file' : 'music') }), a.kind === 'voice' ? 'Voice message' : a.name, a.duration ? ' · ' + Media.fmtDur(a.duration) : ''))));
    if (text) el.append(document.createTextNode(text));
    const idx = c.turns.length; c.turns.push({ el, text: text || '' });
    el.append(h('button', { class: 'uact icon-btn sm', title: 'Undo from here (edit & resend)', html: icon('rotate'), onclick: () => undoTo(c, idx) }));
    c.msgs.append(el); scrollDown(c, true);
  }

  // ---------- undo / retry ----------
  async function undoTo(c, index, opts = {}) {
    if (c.running) { toast('Wait for the agent to finish, or press Stop first', true); return false; }
    const turn = c.turns[index]; if (!turn) return false;
    const sid = c.sessionId || c.resumeId;
    const removing = c.turns.length - index;
    const plan = turn.mark ? await api.cp.plan(turn.mark).catch(() => []) : [];
    const fileList = plan.length ? ' These files will be put back: ' + plan.slice(0, 6).map((p) => (p.action === 'delete' ? '− ' : '↺ ') + p.rel).join(', ') + (plan.length > 6 ? ' … and ' + (plan.length - 6) + ' more' : '') + '.' : ' Files the agent edited are restored when possible.';
    if (!opts.silent && !(await confirmBox('Undo', `Remove ${removing > 1 ? removing + ' messages' : 'this message'} and the agent's replies after ${removing > 1 ? 'them' : 'it'}?${fileList}`, 'Undo'))) return false;
    let res = { ok: true };
    if (sid) {
      res = await api.agent.rewind({ id: c.id, provider: c.cfg.provider, sessionId: sid, keepTurns: index, cwd: c.cwd || A.ws, custom: customPath(c.cfg.provider), cpMark: turn.mark || 0 });
      if (c.cfg.provider === 'claude' || !res.ok) c.started = false;
    }
    if (!res.ok) { toast('Undo failed: ' + (res.error || 'unknown error'), true); return false; }
    // drop everything from that message on
    let n = turn.el; while (n) { const nx = n.nextSibling; if (n !== c.typingEl) n.remove(); n = nx; }
    c.turns.length = index; c.curMsg = null; c.pendingPerms = 0;
    let u = -1; const cut = c.transcript.findIndex((m) => m.role === 'user' && ++u === index); if (cut >= 0) c.transcript.length = cut;
    let eu = -1; const ecut = c.events.findIndex((e) => isUserText(e) && ++eu === index); if (ecut >= 0) { c.events.length = ecut; persist(c, true); }
    c.resumeId = sid || c.resumeId; renderTabs();
    if (res.note && !opts.silent) toast(res.note);
    if (!opts.silent) toast(`Undone${res.filesReverted ? ' · ' + res.filesReverted + ' file' + (res.filesReverted > 1 ? 's' : '') + ' restored' : ''}${res.filesSkipped ? ' · ' + res.filesSkipped + ' could not be restored' : ''}`);
    if (!opts.resend) { c.ta.value = turn.text; c.ta.dispatchEvent(new Event('input')); c.ta.focus(); }
    return turn.text;
  }
  async function retryLast(c) {
    if (c.running || !c.turns.length) return;
    const t = await undoTo(c, c.turns.length - 1, { silent: true, resend: true });
    if (t !== false && t) { c.ta.value = t; submit(c); }
  }
  window.lightbox = (src) => { const l = h('div', { class: 'lightbox', onclick: () => l.remove() }, h('img', { src })); document.body.append(l); };
  const WORDS = ['Thinking', 'Working on it', 'Reasoning', 'Reading the code', 'Putting it together'];
  function showTyping(c) {
    if (c.typingEl) return;
    const lab = h('span', { class: 'shimmer' }, WORDS[0]); let i = 0;
    c.typingTimer = setInterval(() => { lab.textContent = WORDS[++i % WORDS.length]; }, 2600);
    c.typingEl = h('div', { class: 'typing' }, h('span', { class: 'tlogo alive', html: PROV[c.cfg.provider].logo }), lab);
    c.msgs.append(c.typingEl); scrollDown(c);
  }
  function hideTyping(c) { clearInterval(c.typingTimer); if (c.typingEl) { c.typingEl.remove(); c.typingEl = null; } }
  function asstMsg(c, id) {
    let m = c.msgs_by[id]; if (m) return m;
    clearEmpty(c); hideTyping(c);
    m = { id, el: h('div', { class: 'msg asst' }), order: [], byIndex: {} };
    m.el.append(h('div', { class: 'mact' }, h('button', { class: 'icon-btn sm', title: 'Retry this turn', html: icon('refresh'), onclick: () => retryLast(c) }), h('button', { class: 'icon-btn sm', title: 'Copy', html: icon('copy'), onclick: () => { navigator.clipboard.writeText(m.order.filter((b) => b.type === 'text').map((b) => b.raw).join('\n\n')); toast('Copied'); } })));
    c.msgs.append(m.el); c.msgs_by[id] = m;
    if (c.running) showTyping(c);
    return m;
  }
  function addBlock(c, m, b) { m.order.push(b); m.el.append(b.el); if (c.typingEl) c.msgs.append(c.typingEl); return b; }
  function mkText() { const b = { type: 'text', raw: '', el: h('div', { class: 'md' }), final: false }; b.render = () => renderMd(b.el, b.raw, b.final); return b; }
  function mkThinking() {
    const tt = h('div', { class: 'tt' });
    const sum = h('summary', null, h('span', { class: 'shimmer' }, 'Thinking…'));
    const el = h('details', { class: 'thinking' }, sum, tt);
    if (!A.settings.showThinking) el.classList.add('hidden');
    const b = { type: 'thinking', raw: '', el, tt, sum, final: false, t0: Date.now(), done: false };
    // called when the block ends: show how long it thought; if the model gives no reasoning text, the pill is not expandable
    b.finish = () => {
      if (b.done) return; b.done = true;
      const s = Math.max(1, Math.round((Date.now() - b.t0) / 1000));
      sum.textContent = 'Thought for ' + (s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's');
      if (!b.raw) { el.classList.add('empty'); el.title = 'This model does not share its reasoning text'; el.open = false; }
    };
    return b;
  }
  function mkTool(c, id, name, input) {
    const body = h('div', { class: 'tb' });
    const status = h('span', { class: 'ts', html: '<span class="spin"></span>' });
    const sum = h('span', { class: 'tsum' });
    const isAgent = name === 'Agent' || name === 'Task'; let stopBtn = null; const holder = {};
    if (isAgent && c.cfg.provider === 'claude') stopBtn = h('button', { class: 'tstop', title: 'Stop this sub-agent', onclick: (e) => { e.preventDefault(); e.stopPropagation(); stopTaskFor(c, holder.b); } }, 'Stop');
    const el = h('details', { class: 'tool' + (isAgent ? ' agentcard' : '') }, h('summary', null, h('span', { class: 'ti', html: icon(name.startsWith('mcp__') ? 'plug' : isAgent ? 'sparkle' : TOOL_ICON[name] || 'bolt') }), h('span', { class: 'tn' }, isAgent ? 'Sub-agent' : prettyName(name)), sum, ...(stopBtn ? [stopBtn] : []), status), body);
    if (A.settings.expandTools) el.open = true;
    const b = { type: 'tool', id, name, input: input || {}, el, body, sum, status, jsonBuf: '', stopBtn }; holder.b = b;
    c.tools[id] = b; fillTool(c, b);
    if (isAgent && c.cfg.provider !== 'claude') { c.tasks.set('tu:' + id, { id: 'tu:' + id, toolUseId: id, desc: 'Sub-agent', kind: 'agent', sub: '', status: 'running', started: Date.now(), tokens: 0, toolUses: 0 }); window.AgentsPanel && AgentsPanel.touch(); }
    return b;
  }
  // a labelled block inside a tool card, with Copy and Expand on the right
  function toolSec(b, label, content, copyText) {
    b.full = b.full || {}; const pre = h('div', { class: 'tpre' + (b.full[label] ? ' full' : '') }, content);
    const ex = h('button', { class: 'tbtn', title: b.full[label] ? 'Collapse' : 'Expand', html: icon(b.full[label] ? 'shrink' : 'expand') });
    ex.onclick = (e) => { e.preventDefault(); const f = pre.classList.toggle('full'); b.full[label] = f; ex.innerHTML = icon(f ? 'shrink' : 'expand'); ex.title = f ? 'Collapse' : 'Expand'; };
    const cp = copyText == null ? null : h('button', { class: 'tbtn', title: 'Copy', html: icon('copy'), onclick: (e) => { e.preventDefault(); navigator.clipboard.writeText(copyText); toast('Copied'); } });
    return h('div', { class: 'tsec' }, h('div', { class: 'tsh' }, h('span', { class: 'lbl' }, label), h('span', { class: 'sp' }), cp, ex), pre);
  }
  const diffLines = (o, n) => [...String(o).split('\n').map((l) => h('span', { class: 'del' }, '− ' + l)), ...String(n || '').split('\n').map((l) => h('span', { class: 'add' }, '+ ' + l))];
  function fillTool(c, b) {
    b.sum.textContent = toolSummary(b.name, b.input);
    b.body.innerHTML = '';
    const inp = b.input || {}; const add = (...x) => b.body.append(...x);
    if (FILE_TOOLS.has(b.name) && (inp.file_path || inp.notebook_path)) { const fp = inp.file_path || inp.notebook_path; add(h('div', { class: 'tfile' }, h('span', { class: 'fl', title: fp, onclick: () => window.openFile(fp) }, relp(fp)))); }
    if (b.name === 'Edit' && inp.old_string != null) add(toolSec(b, 'diff', diffLines(inp.old_string, inp.new_string), String(inp.new_string || '')));
    else if (b.name === 'MultiEdit' && inp.edits) add(toolSec(b, 'diff', inp.edits.flatMap((e) => diffLines(e.old_string, e.new_string)), inp.edits.map((e) => e.new_string).join('\n')));
    else if (b.name === 'Write' && inp.content != null) add(toolSec(b, 'content', String(inp.content).slice(0, 20000), String(inp.content)));
    else if (b.name === 'ApplyPatch' && inp.patch) add(toolSec(b, 'patch', String(inp.patch).split('\n').slice(0, 400).map((l) => h('span', { class: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '' }, l + '\n')), String(inp.patch)));
    else if (inp.command) { add(toolSec(b, 'command', String(inp.command), String(inp.command))); if (inp.description) add(h('div', { class: 'tdesc' }, inp.description)); }
    else if (b.name === 'TodoWrite' && inp.todos) add(h('div', { class: 'todo-list' }, inp.todos.map((t) => h('div', null, (t.status === 'completed' ? '☑ ' : t.status === 'in_progress' ? '◐ ' : '☐ ') + (t.content || t.activeForm || t.step || '')))));
    else if (Object.keys(inp).length) { const j = JSON.stringify(inp, null, 2); add(toolSec(b, 'input', j, j)); }
    if (b.sub) add(b.sub);
    if (b.result != null) add(toolSec(b, b.resultErr ? 'error' : 'result', b.result.slice(0, 40000) + (b.result.length > 40000 ? '\n… (' + b.result.length + ' chars)' : ''), b.result));
    if (b.images) b.images.forEach((x) => add(h('img', { src: x, style: { maxWidth: '100%', borderRadius: '6px', marginTop: '6px', cursor: 'zoom-in' }, onclick: (e) => lightbox(e.target.src) })));
    const tk = taskFor(c, b.id); if (tk && String(tk.id).startsWith('tu:') && (b.input.description || b.input.prompt)) tk.desc = String(b.input.description || b.input.prompt).slice(0, 80);
  }
  function setToolResult(c, id, content, isErr) {
    const b = c.tools[id]; if (!b) return;
    let txt = '';
    if (typeof content === 'string') txt = content; else if (Array.isArray(content)) txt = content.map((x) => (x.type === 'text' ? x.text : x.type === 'image' ? '[image]' : '')).join('\n');
    b.status.className = 'ts' + (isErr ? ' err' : ''); b.status.innerHTML = icon(isErr ? 'xCircle' : 'check');
    if (b.stopBtn) { b.stopBtn.remove(); b.stopBtn = null; }
    const tk = taskFor(c, id); if (tk && tk.status === 'running') { tk.status = isErr ? 'failed' : 'done'; tk.ended = Date.now(); window.AgentsPanel && AgentsPanel.touch(); }
    b.result = txt; b.resultErr = !!isErr;
    b.images = Array.isArray(content) ? content.filter((x) => x.type === 'image' && x.source).map((x) => `data:${x.source.media_type};base64,${x.source.data}`) : null;
    fillTool(c, b);
  }
  // ---------- sub-agents & background tasks ----------
  const taskFor = (c, toolUseId) => { for (const t of c.tasks.values()) if (t.toolUseId === toolUseId) return t; return null; };
  function stopTask(c, taskId) {
    if (String(taskId).startsWith('tu:')) { toast('This agent cannot stop a single sub-agent — use Stop on the chat', true); return; }
    api.agent.write({ id: c.id, obj: { type: 'control_request', request_id: uuid(), request: { subtype: 'stop_task', task_id: taskId } } }); toast('Stopping…');
  }
  function stopTaskFor(c, b) { const t = taskFor(c, b.id); if (!t) { toast('Waiting for the sub-agent to start…'); return; } stopTask(c, t.id); }
  function focusTask(c, t) {
    selectChat(c); const b = t.toolUseId && c.tools[t.toolUseId];
    if (b) { b.el.open = true; b.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); b.el.classList.add('flash'); setTimeout(() => b.el.classList.remove('flash'), 1400); }
  }
  function onTask(c, ev) {
    const id = ev.task_id; if (!id) return; let t = c.tasks.get(id);
    if (ev.subtype === 'task_started') { t = { id, toolUseId: ev.tool_use_id || null, desc: ev.description || 'Task', kind: ev.task_type || 'agent', sub: ev.subagent_type || '', status: 'running', started: Date.now(), tokens: 0, toolUses: 0 }; c.tasks.set(id, t); }
    if (!t) return;
    if (ev.subtype === 'task_progress') { if (ev.description) t.desc = ev.description; if (ev.usage) { t.tokens = ev.usage.total_tokens || t.tokens; t.toolUses = ev.usage.tool_uses || t.toolUses; } }
    if (ev.subtype === 'task_updated' && ev.patch && ev.patch.status) t.status = ({ completed: 'done', killed: 'stopped', failed: 'failed', error: 'failed' })[ev.patch.status] || t.status;
    if (ev.subtype === 'task_notification') t.status = ({ completed: 'done', stopped: 'stopped', failed: 'failed' })[ev.status] || t.status;
    if (t.status !== 'running' && !t.ended) t.ended = Date.now();
    const b = t.toolUseId && c.tools[t.toolUseId];
    if (b) { b.task = t; if (t.status !== 'running' && b.stopBtn) { b.stopBtn.remove(); b.stopBtn = null; } if (t.status === 'running') b.sum.textContent = (b.lastAct || t.desc) + (t.toolUses ? '  ·  ' + t.toolUses + ' tool calls' : ''); else if (t.status === 'stopped') b.sum.textContent = t.desc + '  ·  stopped'; }
    window.AgentsPanel && AgentsPanel.touch();
  }
  // messages a sub-agent produces are forwarded with parent_tool_use_id → show them live inside its card
  function applyChild(c, ev) {
    const b = c.tools[ev.parent_tool_use_id]; if (!b) return;
    if (!b.sub) { b.sub = h('div', { class: 'subflow' }); b.subTools = {}; fillTool(c, b); }
    const msg = ev.message || {};
    if (ev.type === 'assistant') {
      for (const blk of msg.content || []) {
        if (blk.type === 'text' && blk.text.trim()) b.sub.append(h('div', { class: 'sf-text' }, blk.text.trim().slice(0, 1200)));
        else if (blk.type === 'tool_use') {
          const row = h('div', { class: 'sf-tool' }, h('span', { class: 'ti', html: icon(TOOL_ICON[blk.name] || 'bolt') }), h('b', null, prettyName(blk.name)), h('span', { class: 'sf-s' }, toolSummary(blk.name, blk.input)), h('span', { class: 'sf-st', html: '<span class="spin"></span>' }));
          b.subTools[blk.id] = row; b.sub.append(row); b.lastAct = prettyName(blk.name) + ' ' + toolSummary(blk.name, blk.input).slice(0, 60);
        }
      }
    } else if (ev.type === 'user') {
      for (const blk of Array.isArray(msg.content) ? msg.content : []) if (blk.type === 'tool_result' && b.subTools && b.subTools[blk.tool_use_id]) b.subTools[blk.tool_use_id].querySelector('.sf-st').innerHTML = icon(blk.is_error ? 'xCircle' : 'check');
    }
    if (b.task && b.task.status === 'running') b.sum.textContent = (b.lastAct || b.sum.textContent) + (b.task.toolUses ? '  ·  ' + b.task.toolUses + ' tool calls' : '');
    window.AgentsPanel && AgentsPanel.touch(); scrollDown(c);
  }

  function applyAssistant(c, msg, fromHistory) {
    const m = asstMsg(c, msg.id || uuid());
    for (const blk of msg.content || []) {
      if (blk.type === 'text') {
        let b = m.order.find((x) => x.type === 'text' && !x.final);
        if (!b) b = addBlock(c, m, mkText());
        b.raw = blk.text; b.final = true; b.render();
        if (blk.text && !b.logged) { b.logged = true; c.transcript.push({ role: 'assistant', text: blk.text }); }
      } else if (blk.type === 'thinking') {
        let b = m.order.find((x) => x.type === 'thinking' && !x.final);
        if (!b) { if (!blk.thinking) continue; b = addBlock(c, m, mkThinking()); }
        if (blk.thinking) { b.raw = blk.thinking; b.tt.textContent = blk.thinking; b.el.classList.remove('empty'); }
        b.final = true; b.finish && b.finish();
      } else if (blk.type === 'tool_use') {
        let b = c.tools[blk.id];
        if (!b) b = addBlock(c, m, mkTool(c, blk.id, blk.name, blk.input)); else { b.input = blk.input; fillTool(c, b); }
      }
    }
    if (!fromHistory) { c.events.push({ type: 'assistant', message: { id: msg.id, content: (msg.content || []).filter((b) => b.type !== 'thinking' || b.thinking) } }); persist(c); scrollDown(c); }
  }

  // what the agent is doing right now (the desktop pet shows a thought bubble while the phase is "thinking")
  function setPhase(c, p) { if (c._phase === p) return; c._phase = p; window.PetBridge && PetBridge.sync(); }
  function onStream(c, ev) {
    if (ev.parent_tool_use_id) return;
    const e = ev.event || {};
    if (e.type === 'message_start') { c.curMsg = asstMsg(c, e.message.id); setPhase(c, 'thinking'); return; }
    const m = c.curMsg; if (!m) return;
    if (e.type === 'content_block_start') {
      const cb = e.content_block; let b; setPhase(c, cb.type === 'tool_use' ? 'tool' : cb.type === 'text' ? 'writing' : 'thinking');
      if (cb.type === 'text') b = mkText(); else if (cb.type === 'thinking') b = mkThinking(); else if (cb.type === 'tool_use') b = mkTool(c, cb.id, cb.name, cb.input || {}); else return;
      m.byIndex[e.index] = addBlock(c, m, b);
    } else if (e.type === 'content_block_delta') {
      const b = m.byIndex[e.index]; if (!b) return; const d = e.delta;
      if (d.type === 'text_delta') { b.raw += d.text; schedule(b); }
      else if (d.type === 'thinking_delta') { b.raw += d.thinking; b.tt.textContent = b.raw; b.el.classList.remove('empty'); }
      else if (d.type === 'input_json_delta') { b.jsonBuf += d.partial_json; try { b.input = JSON.parse(b.jsonBuf); fillTool(c, b); } catch { b.sum.textContent = b.jsonBuf.slice(0, 100); } }
      scrollDown(c);
    } else if (e.type === 'content_block_stop') {
      const b = m.byIndex[e.index]; if (b && b.type === 'thinking') b.finish();
    } else if (e.type === 'message_stop' || e.type === 'message_delta') {
      m.order.forEach((b) => b.type === 'thinking' && b.finish && b.finish());
    }
  }
  function schedule(b) { if (b.raf) return; b.raf = requestAnimationFrame(() => { b.raf = 0; b.render(); }); }

  // ---------- "N files changed" review card after every turn: diff, revert or keep each file ----------
  async function showChanges(c) {
    const turn = c.turns[c.turns.length - 1]; if (!turn || !turn.mark) return;
    await new Promise((r) => setTimeout(r, 900)); // let the file watcher record the agent's last writes
    const list = await api.cp.changes(turn.mark).catch(() => []); if (!list.length) return;
    const t = turn.mark; const state = {}; // rel -> 'reverted' | 'kept'
    const card = h('div', { class: 'chg' }); const rows = h('div', { class: 'chg-rows' });
    const total = () => list.reduce((a, x) => ({ a: a.a + x.added, r: a.r + x.removed }), { a: 0, r: 0 });
    const head = h('div', { class: 'chg-h' });
    const drawHead = () => {
      const tt = total(); const open = list.filter((x) => !state[x.rel]).length; head.innerHTML = '';
      head.append(h('span', { class: 'chg-i', html: icon('edit') }), h('b', null, list.length === 1 ? '1 file changed' : list.length + ' files changed'), h('span', { class: 'chg-n' }, h('em', { class: 'a' }, '+' + tt.a), h('em', { class: 'r' }, '−' + tt.r)), h('span', { class: 'sp' }),
        open ? h('button', { class: 'btn sm', onclick: () => revertAll() }, 'Revert all') : null, open ? h('button', { class: 'btn sm ghost', onclick: () => { list.forEach((x) => (state[x.rel] = state[x.rel] || 'kept')); draw(); } }, 'Keep all') : h('span', { class: 'chg-done' }, 'Reviewed'));
    };
    const revert = async (x) => { const r = await api.cp.revertFile({ rel: x.rel, t }); if (r.ok) { state[x.rel] = 'reverted'; draw(); } else toast('Could not revert ' + x.rel + ': ' + (r.error || ''), true); };
    const revertAll = async () => { if (!(await confirmBox('Revert all changes', 'Put ' + (list.length === 1 ? 'this file' : 'these ' + list.length + ' files') + ' back the way they were before this message?', 'Revert all', true))) return; for (const x of list) if (!state[x.rel]) await revert(x); toast('Reverted'); };
    const draw = () => {
      drawHead(); rows.innerHTML = '';
      list.forEach((x) => {
        const st = state[x.rel]; const nm = basename(x.rel), dir = x.rel.includes('/') ? x.rel.slice(0, x.rel.lastIndexOf('/')) : '';
        rows.append(h('div', { class: 'chg-r' + (st ? ' ' + st : '') },
          h('span', { class: 'chg-k ' + x.action, title: x.action, html: icon(x.action === 'created' ? 'plus' : x.action === 'deleted' ? 'trash' : 'edit') }),
          h('span', { class: 'chg-f', onclick: () => App.openDiff({ rel: x.rel, full: x.full, t, action: x.action }), title: 'Show the diff' }, h('b', null, nm), dir ? h('small', null, dir) : null),
          h('span', { class: 'chg-n' }, h('em', { class: 'a' }, '+' + x.added), h('em', { class: 'r' }, '−' + x.removed)),
          st ? h('span', { class: 'chg-s' }, st === 'reverted' ? 'Reverted' : 'Kept') : h('span', { class: 'chg-b' },
            h('button', { class: 'btn sm ghost', onclick: () => App.openDiff({ rel: x.rel, full: x.full, t, action: x.action }) }, 'Diff'),
            h('button', { class: 'btn sm ghost', onclick: () => revert(x) }, 'Revert'), h('button', { class: 'btn sm ghost', onclick: () => { state[x.rel] = 'kept'; draw(); } }, 'Keep'))));
      });
    };
    card.append(head, rows); draw(); hideTyping(c); c.msgs.append(card); scrollDown(c, true);
  }

  // ---------- permission requests ----------
  // Codex/OpenCode report commands as JSON-ish strings with doubled backslashes and shell wrappers; show what will really run
  function prettyCommand(raw) {
    let s = String(raw || '').trim(); let shell = '';
    s = s.replace(/\\\\/g, '\\');
    const wrap = s.match(/^"?(?:[^"]*[\\/])?(powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*-Command\s+([\s\S]+)$/i) || s.match(/^"?(?:[^"]*[\\/])?(cmd)(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/) || s.match(/^"?(?:[^"]*[\\/])?(bash|sh|zsh)(?:\.exe)?"?\s+-\w*c\s+([\s\S]+)$/);
    if (wrap) { shell = ({ powershell: 'PowerShell', pwsh: 'PowerShell', cmd: 'Command Prompt', bash: 'Bash', sh: 'Shell', zsh: 'Zsh' })[wrap[1].toLowerCase()]; s = wrap[2].trim(); }
    if (/^".*"$/.test(s) || /^'.*'$/.test(s)) s = s.slice(1, -1);
    s = s.replace(/\\"/g, '"').replace(/\\'/g, "'");
    return { command: s, shell };
  }
  function describePerm(r) {
    const inp = r.input || {}; const n = r.tool_name;
    const cwd = r.cwd || inp.cwd || '';
    if (inp.command) { const p = prettyCommand(inp.command); return { kind: 'run', icon: 'term', title: p.shell ? 'Run a command in ' + p.shell : 'Run a command', code: p.command, cwd, note: inp.description }; }
    if ((n === 'Write' || n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit' || n === 'ApplyPatch') && (inp.file_path || inp.patch)) {
      const diff = n === 'Edit' ? [['-', inp.old_string], ['+', inp.new_string]] : n === 'Write' ? [['+', String(inp.content || '').slice(0, 1200)]] : n === 'ApplyPatch' ? [['', String(inp.patch).slice(0, 1600)]] : null;
      return { kind: 'edit', icon: 'edit', title: n === 'Write' ? 'Write a file' : 'Edit a file', path: inp.file_path, diff, note: r.description };
    }
    if (inp.url) return { kind: 'net', icon: 'globe', title: 'Open a web page', code: inp.url };
    if (inp.query) return { kind: 'net', icon: 'globe', title: 'Search the web', code: inp.query };
    if (n && n.startsWith('mcp__')) { const t = prettyName(n); return { kind: 'tool', icon: 'plug', title: 'Use a tool', code: t + (Object.keys(inp).length ? '\n' + JSON.stringify(inp, null, 2).slice(0, 1200) : '') }; }
    return { kind: 'tool', icon: 'shield', title: 'Allow ' + prettyName(n || 'this action') + '?', code: JSON.stringify(inp, null, 2).slice(0, 1500), note: r.description };
  }
  function permCard(c, req) {
    const r = req.request; const inp = r.input || {};
    c.pendingPerms++; renderTabs(); c.perms = c.perms || new Set();
    let settled = false;
    const reply = (resp) => api.agent.write({ id: c.id, obj: { type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: resp } } });
    const finish = (label, ok, summary) => {
      if (settled) return; settled = true; c.perms.delete(handle); c.pendingPerms = Math.max(0, c.pendingPerms - 1); if (c.petPerms) c.petPerms.delete(req.request_id); renderTabs();
      card.className = 'perm done' + (ok ? '' : ' no'); card.innerHTML = '';
      card.append(h('div', { class: 'pd' }, h('span', { class: 'pd-i', html: icon(ok ? 'check' : 'x') }), h('span', { class: 'pd-l' }, label), h('span', { class: 'pd-s' }, summary || '')));
    };
    const allow = (extra, label) => { reply({ behavior: 'allow', updatedInput: inp, ...(extra || {}) }); finish(label || 'Allowed', true, sum); };
    const deny = (why, label) => { reply({ behavior: 'deny', message: why || 'The user denied this action.' }); finish(label || 'Declined', false, sum); };
    const handle = { deny: () => deny('The user stopped the agent.', 'Declined (stopped)') }; c.perms.add(handle);
    const card = h('div', { class: 'perm' }); let sum = ''; let petRec = null;

    if (r.tool_name === 'AskUserQuestion' && Array.isArray(inp.questions)) {
      const answers = {}; sum = inp.questions[0] ? inp.questions[0].question : '';
      card.append(h('div', { class: 'ph' }, h('span', { class: 'phi', html: icon('help') }), h('div', { class: 'pt' }, h('b', null, PROV[c.cfg.provider].name + ' has a question'))));
      inp.questions.forEach((q) => {
        const box = h('div', { class: 'q' }, h('b', null, q.question));
        (q.options || []).forEach((o) => {
          const btn = h('button', { class: 'opt', onclick: () => {
            if (q.multiSelect) { const set = new Set((answers[q.question] || '').split(', ').filter(Boolean)); set.has(o.label) ? set.delete(o.label) : set.add(o.label); answers[q.question] = [...set].join(', '); btn.classList.toggle('sel'); }
            else { answers[q.question] = o.label; $$('.opt', box).forEach((x) => x.classList.remove('sel')); btn.classList.add('sel'); }
          } }, o.label, o.description ? h('small', null, o.description) : null);
          box.append(btn);
        });
        const other = h('input', { class: 'inp', placeholder: 'Something else…', style: { marginTop: '4px' }, oninput: () => { if (other.value) { answers[q.question] = other.value; $$('.opt', box).forEach((x) => x.classList.remove('sel')); } } });
        box.append(other); card.append(box);
      });
      card.append(h('div', { class: 'pb' }, h('button', { class: 'btn primary', onclick: () => allow({ updatedInput: { ...inp, answers } }, 'Answered') }, 'Send answers'), h('button', { class: 'btn ghost', onclick: () => deny('The user skipped the question.', 'Skipped') }, 'Skip')));
      const q0 = inp.questions[0] || {};   // the desktop pet can answer the first question
      petRec = { kind: 'question', title: PROV[c.cfg.provider].name + ' has a question', sum: q0.question || '', options: (q0.options || []).map((o) => o.label), answer: (label) => allow({ updatedInput: { ...inp, answers: { [q0.question]: label } } }, 'Answered'), deny: () => deny('The user skipped the question.', 'Skipped') };
    } else if (r.tool_name === 'ExitPlanMode') {
      const pl = h('div', { class: 'md' }); renderMd(pl, inp.plan || '', true); sum = 'Plan';
      card.append(h('div', { class: 'ph' }, h('span', { class: 'phi', html: icon('task') }), h('div', { class: 'pt' }, h('b', null, 'Proposed plan'), h('span', null, 'Review it, then let the agent start'))), pl,
        h('div', { class: 'pb' }, h('button', { class: 'btn primary', onclick: () => allow(null, 'Plan approved') }, 'Approve & start'), h('button', { class: 'btn ghost', onclick: () => deny('Keep planning — the user wants changes to the plan.', 'Asked to keep planning') }, 'Keep planning')));
      petRec = { kind: 'plan', title: 'Proposed plan', sum: String(inp.plan || '').replace(/\s+/g, ' ').slice(0, 140), allow: () => allow(null, 'Plan approved'), deny: () => deny('Keep planning — the user wants changes to the plan.', 'Asked to keep planning') };
    } else {
      const d = describePerm(r); sum = d.code ? d.code.split('\n')[0].slice(0, 90) : d.path || '';
      const head = h('div', { class: 'ph' }, h('span', { class: 'phi', html: icon(d.icon) }), h('div', { class: 'pt' }, h('b', null, d.title), d.note && !/^\s*(null|undefined)?\s*$/i.test(d.note) ? h('span', null, d.note) : null));
      card.append(head);
      if (d.code) card.append(h('div', { class: 'pcode' }, h('pre', null, d.code), h('button', { class: 'icon-btn sm pcopy', title: 'Copy', html: icon('copy'), onclick: () => { navigator.clipboard.writeText(d.code); toast('Copied'); } })));
      if (d.path) card.append(h('div', { class: 'ppath' }, h('span', { class: 'fl', onclick: () => window.openFile(d.path) }, d.path)));
      if (d.diff) card.append(h('div', { class: 'pdiff' }, d.diff.map(([sg, tx]) => h('pre', { class: sg === '-' ? 'del' : sg === '+' ? 'add' : '' }, String(tx || '').split('\n').slice(0, 14).map((l) => (sg ? sg + ' ' : '') + l).join('\n')))));
      if (d.cwd) card.append(h('div', { class: 'pmeta' }, 'in ', h('code', null, d.cwd)));
      const canAlways = r.permission_suggestions && r.permission_suggestions.length;
      card.append(h('div', { class: 'pb' },
        h('button', { class: 'btn primary', onclick: () => allow() }, 'Allow'),
        canAlways ? h('button', { class: 'btn', title: 'Remember this choice for the session', onclick: () => allow({ updatedPermissions: r.permission_suggestions }, 'Allowed (remembered)') }, 'Always allow') : null,
        h('button', { class: 'btn ghost danger', onclick: () => deny() }, 'Deny')));
      petRec = { kind: 'tool', title: d.title, sum: sum || prettyName(r.tool_name), allow: () => allow(), always: canAlways ? () => allow({ updatedPermissions: r.permission_suggestions }, 'Allowed (remembered)') : null, deny: () => deny() };
    }
    if (petRec) { petRec.id = req.request_id; (c.petPerms = c.petPerms || new Map()).set(req.request_id, petRec); }   // lets the desktop pet show Allow / Deny too
    hideTyping(c); c.msgs.append(card); scrollDown(c, true);
    if (window.petHook) window.petHook(c, 'perm');
    if (document.hidden && A.settings.notify !== false) api.notify({ title: PROV[c.cfg.provider].name + ' needs your approval', body: sum || prettyName(r.tool_name), chatId: c.id });
  }

  let usageTimer = null;
  function onEvent(c, ev) {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          c.sessionId = ev.session_id || c.sessionId; c.model = ev.model || c.model; persist(c);
          if (!c.commands.length) c.commands = (ev.slash_commands || []).map((n) => ({ name: n }));
          updateStatus();
        } else if (/^task_/.test(ev.subtype || '')) onTask(c, ev);
        else if (ev.subtype === 'commands_changed') c.commands = (ev.commands || []).map((x) => ({ name: x.name, description: x.description }));
        break;
      case 'stream_event': onStream(c, ev); break;
      case 'assistant': if (!ev.parent_tool_use_id) { applyAssistant(c, ev.message); const bl = (ev.message && ev.message.content) || []; if (bl.some((b) => b.type === 'tool_use')) setPhase(c, 'tool'); else if (bl.some((b) => b.type === 'text' && b.text)) setPhase(c, 'writing'); } else applyChild(c, ev); break;
      case 'user': {
        if (ev.parent_tool_use_id) { applyChild(c, ev); break; }
        const content = ev.message && ev.message.content;
        if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) setPhase(c, 'thinking');
        if (Array.isArray(content)) { const trs = []; for (const blk of content) if (blk.type === 'tool_result') { setToolResult(c, blk.tool_use_id, blk.content, blk.is_error); trs.push({ ...blk, content: clip(blk.content) }); } if (trs.length) { c.events.push({ type: 'user', message: { role: 'user', content: trs } }); persist(c); } }
        break;
      }
      case 'control_request':
        if (ev.request && ev.request.subtype === 'can_use_tool') permCard(c, ev);
        else api.agent.write({ id: c.id, obj: { type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: 'unsupported' } } });
        break;
      case 'usage_event': Usage.set(ev.provider || c.cfg.provider, { plan: ev.plan, windows: ev.windows, credits: ev.credits }); break;
      case 'token_usage': { const t = ev.total || {}; c.tokens = { ...t, input: t.input ?? t.input_tokens ?? 0, output: t.output ?? t.output_tokens ?? 0 }; Usage.renderButton(); updateStatus(); break; }
      case 'rate_limit_event': if (!(A.usage.claude && A.usage.claude.windows)) { const u = ev.rate_limit_info && ev.rate_limit_info.unifiedWindows; if (u) Usage.set('claude', { windows: [u.five_hour && { id: 'session', label: '5-hour', usedPct: u.five_hour.utilization * 100, resetsAt: u.five_hour.resetsAt }, u.seven_day && { id: 'weekly', label: 'Weekly', usedPct: u.seven_day.utilization * 100, resetsAt: u.seven_day.resetsAt }].filter(Boolean) }); } break;
      case 'result': {
        c.curMsg = null;
        if (typeof ev.total_cost_usd === 'number' && ev.total_cost_usd) c.cost = c.cfg.provider === 'claude' ? ev.total_cost_usd : c.cost + ev.total_cost_usd;
        if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) sysLine(c, (ev.result || ev.subtype || 'Error'), true);
        else if (ev.duration_ms) sysLine(c, `${(ev.duration_ms / 1000).toFixed(1)}s${ev.total_cost_usd ? ' · $' + ev.total_cost_usd.toFixed(4) : ''}${ev.usage && (ev.usage.input_tokens || ev.usage.output_tokens) ? ' · ' + fmtTok((ev.usage.input_tokens || 0) + (ev.usage.output_tokens || 0)) + ' tokens' : ''}`);
        setRunning(c, false);
        if (window.petHook) window.petHook(c, ev.is_error || (ev.subtype && ev.subtype !== 'success') ? 'fail' : 'done');
        persist(c, true); showChanges(c);
        clearTimeout(usageTimer); usageTimer = setTimeout(() => Usage.refresh(c.cfg.provider === 'codex' ? undefined : c.cfg.provider), 2500);
        if (document.hidden && A.settings.notify !== false && ev.subtype === 'success') api.notify({ title: PROV[c.cfg.provider].name + ' finished', body: c.title, chatId: c.id });
        break;
      }
      case 'stderr': if (ev.text.trim()) sysLine(c, ev.text.trim().slice(0, 600), true); break;
      case 'raw': break;
    }
  }

  // ---------- Reva's own chat store (survives CLI history deletion) ----------
  const clip = (x) => (typeof x === 'string' ? x.slice(0, 6000) : Array.isArray(x) ? x.map((b) => (b.type === 'text' ? { ...b, text: String(b.text || '').slice(0, 6000) } : b.type === 'image' ? { type: 'text', text: '[image]' } : b)) : x);
  const isUserText = (e) => e.type === 'user' && Array.isArray(e.message && e.message.content) && !e.message.content.some((b) => b.type === 'tool_result') && e.message.content.some((b) => (b.type === 'text' && !String(b.text).startsWith('<')) || b.type === 'image');
  const persistTimers = new WeakMap();
  function persist(c, now) {
    clearTimeout(persistTimers.get(c));
    const go = () => { if (!c.events.length) return; if (!c.revaId) c.revaId = c.id; api.chats.save({ id: c.revaId, meta: { provider: c.cfg.provider, title: c.title, cwd: c.cwd || A.ws, model: c.model || c.cfg.model || '', sessionId: c.sessionId || c.resumeId || null, createdAt: c.created }, events: c.events }); };
    if (now) go(); else persistTimers.set(c, setTimeout(go, 1500));
  }
  async function loadHistory(c, revaId) {
    const evs = revaId ? await api.chats.read(revaId) : await api.sessions.read({ provider: c.cfg.provider, id: c.resumeId, custom: { codex: customPath('codex'), opencode: customPath('opencode') }[c.cfg.provider] });
    // keep the replayed events so continuing this chat stores the whole conversation in Reva's own folder
    c.events = evs.filter((ev) => ev.message && !ev.isMeta && !ev.isSidechain).map((ev) => ({ type: ev.type, message: ev.message }));
    for (const ev of evs) {
      if (ev.isMeta || ev.isSidechain) continue;
      const msg = ev.message; if (!msg) continue;
      if (ev.type === 'assistant') applyAssistant(c, { ...msg, id: msg.id || ev.uuid }, true);
      else if (ev.type === 'user') {
        const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }];
        content.filter((x) => x.type === 'tool_result').forEach((x) => setToolResult(c, x.tool_use_id, x.content, x.is_error));
        const txt = content.filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
        const imgs = content.filter((x) => x.type === 'image' && x.source).map((x) => ({ mediaType: x.source.media_type, data: x.source.data }));
        if ((txt && !txt.startsWith('<')) || imgs.length) userMsg(c, txt.startsWith('<') ? '' : txt, imgs);
      }
    }
    c.curMsg = null; scrollDown(c, true);
  }

  // ---------- wiring ----------
  window.Chat = {
    init() {
      buildChatPanel();
      api.on('agent:event', ({ id, ev }) => { const c = chats.find((x) => x.id === id); if (c) onEvent(c, ev); });
      api.on('agent:exit', ({ id, code, error }) => {
        const c = chats.find((x) => x.id === id); if (!c) return;
        const was = c.running; c.started = false;
        if (was) { sysLine(c, error ? PROV[c.cfg.provider].name + ' failed: ' + error : PROV[c.cfg.provider].name + ' process exited' + (code ? ' (code ' + code + ')' : ''), !!code); setRunning(c, false); }
      });
      newChat();
    },
    attachImage(img) { const c = A.activeChat; if (c) addImage(c, { name: img.name || 'screenshot.png', mediaType: img.mediaType || 'image/png', data: img.data }); },
    stopTask, focusTask, closeChat, interrupt, feed: (ev, c) => onEvent(c || A.activeChat, ev), userMsg: (t, c) => userMsg(c || A.activeChat, t, []),
    new: newChat, insert(t) { const c = A.activeChat; if (c) insertText(c, t); }, active: () => A.activeChat, select: selectChat,
    sendNow(text) { const c = A.activeChat; if (!c) return; c.ta.value = text; submit(c); },
    refreshEmpty() { chats.forEach((c) => { if (c.emptyEl) renderEmpty(c); updateChip(c); }); renderTabs(); },
    rerenderEmpty(c) { renderEmpty(c); updateChip(c); },
    renderTabs, updateChip, updateCtxChip: () => chats.forEach(updateCtxChip),
    hideThinking(v) { $$('.thinking').forEach((e) => e.classList.toggle('hidden', !v)); },
  };
})();
