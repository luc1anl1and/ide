// Desktop pet renderer: sprite animation, roaming, speech bubbles and the click toolbar (ask the AI / activity).
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const k in props || {}) { const v = props[k]; if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v); }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
    return el;
  };
  const IC = {
    x: '<path d="M6 6l12 12M18 6L6 18"/>', ide: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>', check: '<path d="M5 12.5l4.5 4.5L19 7"/>', chev: '<path d="M6 9l6 6 6-6"/>', eyeoff: '<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.9 10.9 0 0 1 12 5c7 0 11 7 11 7a18 18 0 0 1-3.2 4M6.1 6.1A18 18 0 0 0 1 12s4 7 11 7a10.7 10.7 0 0 0 5.4-1.5"/>',
  };
  const ic = (n) => '<svg viewBox="0 0 24 24">' + IC[n] + '</svg>';

  const CW = 192, CH = 208;                 // logical cell size (scaled by cfg.scale)
  const ROW = { idle: 0, right: 1, left: 2, wave: 3, jump: 4, fail: 5, wait: 6, run: 7, review: 8 };
  const FPS = { idle: 5, right: 12, left: 12, wave: 6, jump: 8, fail: 8, wait: 4, run: 12, review: 5 };
  let cfg = { scale: .75, wander: true, bubbles: true, quips: true, id: 'reva', pets: [], pc: {} };
  let state = { chats: [], providers: [] };
  let petDef = null, sheet = { img: null, frames: [], cols: 8, ok: false };
  let pos = { x: 0, y: 0, w: 380, h: 260 }, wa = { x: 0, y: 0, width: 1920, height: 1040 };
  let mode = 'idle', modeUntil = 0, frame = 0, acc = 0, dir = 1, panelOpen = false, dragging = false, interactive = false, lastSent = 0;
  let target = null, nextAct = Date.now() + 3500, pcUntil = 0, bubbleTimer = null, pcText = '', tab = 'ask';
  const form = { provider: null, chatId: '' };
  const petEl = $('#pet'), bubble = $('#bubble'), panel = $('#panel'), askEl = $('#ask'), thoughtEl = $('#thought');
  const dispW = () => Math.round(CW * (cfg.scale || .75)), dispH = () => Math.round(CH * (cfg.scale || .75));

  // ------------------------------------------------------------ theme + sprite
  function applyVars(v) { if (v) for (const k in v) if (v[k]) document.documentElement.style.setProperty(k, v[k]); }
  function loadPet() {
    petDef = (cfg.pets || []).find((p) => p.id === cfg.id) || (cfg.pets || [])[0] || null;
    if (!petDef) return;
    petEl.classList.toggle('pixel', !!petDef.pixel); petEl.classList.toggle('img', petDef.kind === 'image');
    const want = petDef.id;
    window.petApi.sheet(petDef.id).then((data) => { if (!data || want !== petDef.id) return; petEl.style.backgroundImage = 'url("' + data + '")'; const img = new Image(); img.onload = () => { try { analyse(img); } catch (e) { sheet.frames = []; } sizePet(); paint(); }; img.src = data; });
  }
  function analyse(img) {
    {
      sheet.img = img; sheet.ok = true;
      if (petDef.kind === 'image') { sheet.frames = []; }
      else {
        sheet.cols = 8; const cw = img.naturalWidth / 8; const rows = Math.max(1, Math.round(img.naturalHeight / (cw * CH / CW))); const chh = img.naturalHeight / rows;
        const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
        sheet.rows = rows; sheet.frames = [];
        for (let r = 0; r < rows; r++) {
          let n = 0;
          for (let c = 0; c < 8; c++) {
            const d = g.getImageData(Math.floor(c * cw), Math.floor(r * chh), Math.floor(cw), Math.floor(chh)).data; let any = false;
            for (let i = 3; i < d.length; i += 64) if (d[i] > 24) { any = true; break; }
            if (any) n = c + 1; else break;
          }
          sheet.frames.push(n);
        }
      }
    }
  }
  function sizePet() {
    const w = dispW(), hh = dispH(); petEl.style.width = w + 'px'; petEl.style.height = hh + 'px';
    if (petDef && petDef.kind !== 'image') petEl.style.backgroundSize = w * 8 + 'px ' + (sheet.rows || 11) * hh + 'px';
  }
  function rowFrames(name) { const r = ROW[name]; const n = (sheet.frames || [])[r]; return n > 0 ? [r, n] : [0, Math.max(1, (sheet.frames || [])[0] || 1)]; }
  function paint() {
    if (!petDef) return;
    petEl.className = (petDef.pixel ? 'pixel ' : '') + (petDef.kind === 'image' ? 'img ' + (mode === 'right' || mode === 'left' ? 'walk' : mode) : '') + (dragging ? ' dragging' : '');
    if (petDef.kind === 'image') { petEl.style.transform = mode === 'left' ? 'scaleX(-1)' : ''; return; }
    const [r, n] = rowFrames(mode === 'drag' ? 'jump' : mode); const f = mode === 'drag' ? Math.min(2, n - 1) : frame % n;
    petEl.style.backgroundPosition = -f * dispW() + 'px ' + -r * dispH() + 'px';
  }
  function setMode(m, ms) { if (mode !== m) { mode = m; frame = 0; acc = 0; } modeUntil = ms ? Date.now() + ms : 0; paint(); }

  // ------------------------------------------------------------ AI activity -> behaviour
  const working = () => state.chats.some((c) => c.state === 'working');
  const needs = () => state.chats.some((c) => c.state === 'approval');
  const perms = () => state.perms || [];
  const thinking = () => state.chats.some((c) => c.state === 'working' && c.phase === 'thinking') && !state.chats.some((c) => c.state === 'working' && c.phase !== 'thinking');
  function baseMode() { if (Date.now() < pcUntil) return 'run'; if (needs() || perms().length) return 'wait'; if (thinking()) return 'wait'; if (working()) return 'run'; return 'idle'; }
  function updateThought() { thoughtEl.classList.toggle('hidden', !thinking() || dragging); }

  // ------------------------------------------------------------ bubbles
  const QUIPS = ['If you need help, just let me know', 'Want me to look into something?', 'Stuck on a bug? Ask me.', 'Tip: click me to prompt the AI without opening the IDE.', 'I can keep an eye on your agents while you work.', 'Time for a stretch?', 'Need a second pair of eyes on that code?', 'Ask away - I will pass it on to your agent.'];
  function say(html, o = {}) {
    if (!cfg.bubbles && !o.force) return; if (panelOpen || !askEl.classList.contains('hidden')) return;
    clearTimeout(bubbleTimer); bubble.innerHTML = ''; bubble.append(typeof html === 'string' ? html : html);
    bubble.onclick = () => { hideBubble(); if (o.chatId) window.petApi.cmd({ fn: 'open', chatId: o.chatId }); else openPanel('ask'); };
    bubble.classList.remove('hidden');
    bubbleTimer = setTimeout(hideBubble, o.ms || 5500 + String(bubble.textContent).length * 30);
  }
  function hideBubble() { clearTimeout(bubbleTimer); bubble.classList.add('hidden'); }
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  function onEvent(e) {
    if (e.kind === 'done') { setMode('jump', 1100); setTimeout(() => { setMode('review', 2600); }, 1100); say(h('div', null, h('b', null, e.name + ' is ready'), h('small', null, clip(e.title, 60))), { chatId: e.chatId }); }
    else if (e.kind === 'perm') { setMode('wait', 1500); /* the approval card shows up with the next state update */ }
    else if (e.kind === 'fail') { setMode('fail', 3200); say(h('div', null, h('b', null, e.name + ' hit an error'), h('small', null, clip(e.title, 60))), { chatId: e.chatId, ms: 8000 }); }
    else if (e.kind === 'hidden') say("Reva is still running in the tray. I'm here if you need me!", { ms: 6500, force: true });
  }

  // ------------------------------------------------------------ roaming
  // several monitors: every work area is a place the pet may walk to (positions are in virtual-desktop DIPs)
  let displays = [];
  function limits(area) {
    area = area || wa; const w = dispW(); const sideGap = (pos.w - w) / 2;
    return { minX: area.x - sideGap, maxX: area.x + area.width - w - sideGap, minY: area.y - 4, maxY: area.y + area.height - pos.h + 4 };
  }
  const areaAt = (p) => displays.find((d) => p.x >= d.x && p.x < d.x + d.width && p.y >= d.y && p.y < d.y + d.height) || wa;
  async function refreshBounds() { const b = await window.petApi.bounds(); if (b) { pos.x = b.b.x; pos.y = b.b.y; pos.w = b.b.width; pos.h = b.b.height; wa = b.wa; displays = b.displays || [b.wa]; } }
  function pickTarget() {
    const area = displays.length > 1 && Math.random() < .4 ? displays[Math.floor(Math.random() * displays.length)] : wa; const L = limits(area); target = { x: L.minX + Math.random() * (L.maxX - L.minX), y: L.minY + Math.random() * (L.maxY - L.minY) };
    // prefer the lower part of the screen: it looks natural and keeps clear of title bars
    if (Math.random() < .6) target.y = L.minY + (L.maxY - L.minY) * (.55 + Math.random() * .45);
  }
  function sendPos(force) { const now = performance.now(); if (!force && now - lastSent < 16) return; lastSent = now; window.petApi.move(Math.round(pos.x), Math.round(pos.y)); }
  function step(dt) {
    if (!target) return;
    const dx = target.x - pos.x, dy = target.y - pos.y, d = Math.hypot(dx, dy), v = 85 * dt;
    if (d <= v) { pos.x = target.x; pos.y = target.y; target = null; sendPos(true); window.petApi.savePos(); refreshBounds(); setMode(baseMode()); nextAct = Date.now() + 2500 + Math.random() * 7000; return; }
    pos.x += dx / d * v; pos.y += dy / d * v; sendPos();
    const m = dx >= 0 ? 'right' : 'left'; if (mode !== m) setMode(m);
  }
  function behave() {
    const now = Date.now();
    if (modeUntil && now > modeUntil && !target) setMode(baseMode());
    if (dragging || panelOpen || target) return;
    if (mode === 'idle' || mode === 'run' || mode === 'wait') { const b = baseMode(); if (mode !== b && !modeUntil) setMode(b); }
    if (now < nextAct) return;
    nextAct = now + 3000 + Math.random() * 8000;
    if (working() || needs() || !cfg.wander) { if (Math.random() < .12 && mode === 'idle') setMode('wave', 1500); return; }
    const r = Math.random();
    if (r < .55) { pickTarget(); setMode(target.x >= pos.x ? 'right' : 'left'); }
    else if (r < .75) setMode('wave', 1600);
    else if (r < .88) setMode('jump', 1100);
  }
  let last = performance.now();
  function tick(t) {
    const dt = Math.min(.1, (t - last) / 1000); last = t;
    step(dt);
    acc += dt; const fps = FPS[mode] || 6; const n = petDef && petDef.kind !== 'image' ? rowFrames(mode === 'drag' ? 'jump' : mode)[1] : 1;
    if (acc >= 1 / fps) { acc = 0; frame = (frame + 1) % Math.max(1, n); paint(); }
    requestAnimationFrame(tick);
  }
  setInterval(behave, 250);
  setInterval(() => { // quips
    if (!cfg.bubbles || !cfg.quips || panelOpen || dragging || working() || needs() || Math.random() < .35) return;
    say(QUIPS[Math.floor(Math.random() * QUIPS.length)]);
  }, 70000);

  // ------------------------------------------------------------ pointer: drag / click, click-through
  function setInteractive(on) { if (on !== interactive) { interactive = on; window.petApi.interactive(on); } }
  document.addEventListener('mousemove', (e) => { if (dragging) return; setInteractive(!!e.target.closest('#pet,#bubble,#panel,#ask,.menu')); });
  document.addEventListener('mouseleave', () => { if (!dragging) setInteractive(false); });
  petEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; try { petEl.setPointerCapture(e.pointerId); } catch { }
    const sx = e.screenX, sy = e.screenY; let px = pos.x, py = pos.y, moved = false; target = null;
    window.petApi.bounds().then((b) => { if (b && !moved) { pos.x = px = b.b.x; pos.y = py = b.b.y; pos.w = b.b.width; pos.h = b.b.height; wa = b.wa; } });
    const mv = (ev) => {
      const dx = ev.screenX - sx, dy = ev.screenY - sy;
      if (!moved && Math.hypot(dx, dy) > 5) { moved = true; dragging = true; hideBubble(); setMode('drag'); petEl.classList.add('dragging'); }
      if (moved) { pos.x = px + dx; pos.y = py + dy; sendPos(true); }
    };
    const up = () => {
      petEl.removeEventListener('pointermove', mv); petEl.removeEventListener('pointerup', up); petEl.classList.remove('dragging');
      if (moved) { dragging = false; window.petApi.savePos(); setMode('jump', 700); nextAct = Date.now() + 4000; } else togglePanel();
    };
    petEl.addEventListener('pointermove', mv); petEl.addEventListener('pointerup', up);
  });

  // ------------------------------------------------------------ approvals: Allow / Deny right on the desktop
  const sendPerm = (p, action, value) => { window.petApi.cmd({ fn: 'perm', chatId: p.chatId, id: p.id, action, value }); state.perms = perms().filter((x) => x.id !== p.id); renderAsk(); renderPanel(); updateThought(); };
  function apvCard(p) {
    const btn = (label, cls, fn) => h('button', { class: 'abtn ' + cls, onclick: fn }, label);
    const body = [h('div', { class: 'at' }, h('span', { class: 'lg', html: provLogo(p.provider) }), h('b', null, p.title), h('small', null, clip(p.chatTitle, 22)))];
    if (p.sum) body.push(p.kind === 'tool' ? h('code', null, clip(p.sum, 220)) : h('div', { style: { color: 'var(--fg2)' } }, clip(p.sum, 180)));
    if (p.kind === 'question') body.push(h('div', { class: 'ab' }, (p.options || []).slice(0, 5).map((o) => btn(clip(o, 28), 'p', () => sendPerm(p, 'answer', o))), btn('Skip', 'd', () => sendPerm(p, 'deny'))));
    else if (p.kind === 'plan') body.push(h('div', { class: 'ab' }, btn('Approve & start', 'p', () => sendPerm(p, 'allow')), btn('Keep planning', '', () => sendPerm(p, 'deny'))));
    else body.push(h('div', { class: 'ab' }, btn('Allow', 'p', () => sendPerm(p, 'allow')), p.always ? btn('Always allow', '', () => sendPerm(p, 'always')) : null, btn('Deny', 'd', () => sendPerm(p, 'deny'))));
    return h('div', { class: 'apv' }, body);
  }
  function renderAsk() {
    const list = perms(); const show = list.length && !panelOpen && !dragging;
    askEl.classList.toggle('hidden', !show);
    if (show) { hideBubble(); askEl.innerHTML = ''; list.slice(0, 2).forEach((p) => askEl.append(apvCard(p))); if (list.length > 2) askEl.append(h('div', { class: 'more' }, '+' + (list.length - 2) + ' more waiting')); }
    fit();
  }
  // ------------------------------------------------------------ toolbar
  const PH = 408;
  // the window is only as tall as it needs to be: the pet alone, + the approval card, or + the toolbar
  let curH = 260;
  async function fit() {
    let H = 260;
    if (panelOpen) H = 260 + PH - 60; else if (!askEl.classList.contains('hidden')) H = Math.max(260, dispH() + 30 + askEl.offsetHeight + 24);
    H = Math.round(H); if (H === curH) return; curH = H;
    const b = await window.petApi.resize(380, H); if (b) { pos.x = b.x; pos.y = b.y; pos.w = b.width; pos.h = b.height; } const bb = await window.petApi.bounds(); if (bb) wa = bb.wa;
  }
  const resizeTo = () => fit();
  async function openPanel(t) {
    await refreshBounds();
    if (t) tab = t; hideBubble(); target = null; if (!panelOpen) { panelOpen = true; askEl.classList.add('hidden'); await resizeTo(true); }
    panel.classList.remove('hidden'); renderPanel(); setMode('wave', 1200); setInteractive(true);
    await window.petApi.focusInput(); const ta = $('textarea', panel); if (ta && tab === 'ask') ta.focus();
  }
  async function closePanel() { if (!panelOpen) return; panelOpen = false; panel.classList.add('hidden'); renderAsk(); await resizeTo(false); setMode(baseMode()); }
  function togglePanel() { panelOpen ? closePanel() : openPanel('ask'); }
  window.addEventListener('blur', () => { setTimeout(() => { if (panelOpen && !document.hasFocus() && !$('.menu')) closePanel(); }, 200); });

  function openMenu(anchor, items, onPick) {
    $$menus(); const r = anchor.getBoundingClientRect();
    const m = h('div', { class: 'menu' }, items.map((it) => h('div', { onclick: () => { m.remove(); onPick(it.value); } }, it.logo ? h('span', { class: 'lg', html: it.logo }) : null, h('span', null, it.label))));
    document.body.append(m); const mh = m.offsetHeight; m.style.left = Math.max(6, Math.min(r.left, window.innerWidth - m.offsetWidth - 6)) + 'px'; m.style.top = (r.top - mh - 4 > 6 ? r.top - mh - 4 : r.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } }, true), 0);
  }
  const $$menus = () => document.querySelectorAll('.menu').forEach((m) => m.remove());
  const provName = (id) => { const p = (state.providers || []).find((x) => x.id === id); return p ? p.name : id; };
  const provLogo = (id) => { const p = (state.providers || []).find((x) => x.id === id); return p ? p.logo : ''; };
  const STATE_LABEL = { working: 'Working…', approval: 'Needs approval', ready: 'Ready', failed: 'Error', idle: 'Idle' };
  const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm'; };

  function renderPanel() {
    if (!panelOpen) return; const keep = $('textarea', panel) ? $('textarea', panel).value : '';
    const chats = state.chats || []; const nW = chats.filter((c) => c.state === 'working').length, nA = chats.filter((c) => c.state === 'approval').length, nR = chats.filter((c) => c.state === 'ready').length;
    const sub = [nW && nW + ' working', nA && nA + ' need approval', nR && nR + ' ready'].filter(Boolean).join(' · ') || (state.ws ? 'Working in ' + state.ws : 'Idle');
    panel.innerHTML = '';
    panel.append(
      h('div', { class: 'ph' }, h('div', { class: 't' }, h('b', null, petDef ? petDef.name : 'Reva'), h('span', null, sub)),
        h('button', { class: 'ib', title: 'Open Reva', html: ic('ide'), onclick: () => window.petApi.openIde() }),
        h('button', { class: 'ib', title: 'Hide the pet (tray menu brings it back)', html: ic('eyeoff'), onclick: () => window.petApi.hide() }),
        h('button', { class: 'ib', title: 'Close', html: ic('x'), onclick: closePanel })),
      h('div', { class: 'tabs' },
        h('button', { class: tab === 'ask' ? 'on' : '', onclick: () => { tab = 'ask'; renderPanel(); setTimeout(() => { const t = $('textarea', panel); t && t.focus(); }, 0); } }, 'Ask AI'),
        h('button', { class: tab === 'act' ? 'on' : '', onclick: () => { tab = 'act'; renderPanel(); } }, 'Activity', (nW + nA) ? h('i', null, String(nW + nA)) : null)));
    panel.append(tab === 'ask' ? askPane(keep) : actPane());
    const g = cfg.pc || {};
    if (g.view || g.control || pcText) panel.append(h('div', { class: 'pcbar' }, h('span', null, pcText ? pcText : 'PC access allowed this session (' + (g.control ? 'view + control' : 'view only') + ')'), h('button', { onclick: () => { window.petApi.revoke(); pcText = ''; } }, 'Stop')));
  }
  function askPane(keep) {
    const provs = state.providers || []; if (!form.provider || !provs.some((p) => p.id === form.provider)) form.provider = (provs[0] || {}).id || 'claude';
    const chats = (state.chats || []); if (form.chatId && !chats.some((c) => c.id === form.chatId)) form.chatId = '';
    const pBtn = h('button', { class: 'sel', title: 'Which agent' }, h('span', { class: 'lg', html: provLogo(form.provider) }), h('span', { class: 'l' }, provName(form.provider)), h('span', { class: 'car', html: ic('chev') }));
    pBtn.onclick = () => openMenu(pBtn, provs.map((p) => ({ value: p.id, label: p.name, logo: p.logo })), (v) => { form.provider = v; renderPanel(); });
    const cur = chats.find((c) => c.id === form.chatId);
    const cBtn = h('button', { class: 'sel', title: 'Which chat' }, h('span', { class: 'l' }, cur ? cur.title : 'New chat'), h('span', { class: 'car', html: ic('chev') }));
    cBtn.onclick = () => openMenu(cBtn, [{ value: '', label: 'New chat' }, ...chats.map((c) => ({ value: c.id, label: c.title, logo: provLogo(c.provider) }))], (v) => { form.chatId = v; if (v) form.provider = (chats.find((c) => c.id === v) || {}).provider || form.provider; renderPanel(); });
    const ta = h('textarea', { placeholder: 'Ask your AI to do something…', spellcheck: 'false' }); ta.value = keep || '';
    const send = h('button', { class: 'send' }, 'Send');
    const go = () => { const t = ta.value.trim(); if (!t) return; window.petApi.cmd({ fn: 'prompt', text: t, provider: form.provider, chatId: form.chatId || null }); ta.value = ''; say(h('div', null, h('b', null, 'On it'), h('small', null, clip(t, 60))), { ms: 3500 }); setMode('run', 2500); tab = 'act'; closePanelSoon(); };
    send.onclick = go; ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } else if (e.key === 'Escape') closePanel(); });
    const upd = () => { send.disabled = !ta.value.trim(); }; ta.addEventListener('input', upd); upd();
    return h('div', { class: 'body' }, h('div', { class: 'sel-row' }, cur ? null : pBtn, cBtn), h('div', { class: 'input' }, ta, h('div', { class: 'bar' }, h('span', null, 'Enter to send · Shift+Enter new line'), send)));
  }
  const closePanelSoon = () => setTimeout(() => closePanel(), 350);
  function actPane() {
    const chats = (state.chats || []).slice().sort((a, b) => ({ approval: 0, working: 1, failed: 2, ready: 3, idle: 4 }[a.state] - { approval: 0, working: 1, failed: 2, ready: 3, idle: 4 }[b.state]));
    const body = h('div', { class: 'body' });
    perms().forEach((p) => body.append(apvCard(p)));
    if (!chats.length) body.append(h('div', { class: 'empty' }, 'No chats yet. Ask something in the Ask AI tab.'));
    chats.forEach((c) => {
      const badge = h('span', { class: 'badge ' + c.state }, c.state === 'working' ? h('span', { class: 'spin' }) : c.state === 'ready' ? h('span', { html: ic('check') }) : null, STATE_LABEL[c.state] || c.state);
      body.append(h('div', { class: 'chat', onclick: () => window.petApi.cmd({ fn: 'open', chatId: c.id }), title: 'Open in Reva' },
        h('span', { class: 'lg', html: provLogo(c.provider) }),
        h('div', { class: 'ct' }, h('b', null, c.title), h('span', null, provName(c.provider) + (c.state === 'working' && c.since ? ' · ' + ago(c.since) : '') + (c.tokens ? ' · ' + Math.round(c.tokens / 100) / 10 + 'k tokens' : ''))),
        badge,
        c.state === 'working' ? h('button', { class: 'ib', title: 'Stop', html: ic('stop'), onclick: (e) => { e.stopPropagation(); window.petApi.cmd({ fn: 'interrupt', chatId: c.id }); } }) : null));
    });
    return body;
  }

  // ------------------------------------------------------------ messages from the app
  function applyCfg(c) {
    const prevId = cfg.id, prevScale = cfg.scale; cfg = { ...cfg, ...c }; applyVars(cfg.vars);
    if (!petDef || prevId !== cfg.id || !(c.pets === undefined) || prevScale !== cfg.scale) { loadPet(); sizePet(); }
    renderPanel();
  }
  window.petApi.on('pet:cfg', applyCfg);
  window.petApi.on('pet:state', (s) => { state = { ...state, ...s }; if (!panelOpen && !modeUntil && !target && ['idle', 'run', 'wait'].includes(mode) && mode !== baseMode()) setMode(baseMode()); renderAsk(); updateThought(); renderPanel(); });
  window.petApi.on('pet:event', onEvent);
  window.petApi.on('pet:open', (o) => openPanel((o && o.tab) || 'ask'));
  window.petApi.on('pet:pc', (m) => {
    if (m.grants) { cfg.pc = m.grants; if (!m.grants.view && !m.grants.control) pcText = ''; renderPanel(); }
    if (m.cursor && !dragging && !panelOpen && cfg.wander !== false) { // keep the pet company next to where the AI is working
      const L = limits(areaAt(m.cursor)); const nx = Math.max(L.minX, Math.min(L.maxX, m.cursor.x + 60 - pos.w / 2)), ny = Math.max(L.minY, Math.min(L.maxY, m.cursor.y + dispH() * .7 - pos.h + 4));
      if (Math.hypot(nx - pos.x, ny - pos.y) > 160) { target = { x: nx, y: ny }; setMode(nx >= pos.x ? 'right' : 'left'); }
    }
    if (m.activity) { pcText = 'AI: ' + clip(m.activity, 80); pcUntil = Date.now() + 4000; setMode('run', 4000); say(h('div', null, h('b', null, 'Using your PC'), h('small', null, clip(m.activity, 80))), { ms: 3500, force: true }); renderPanel(); setTimeout(() => { if (Date.now() >= pcUntil) { pcText = ''; renderPanel(); } }, 4200); }
  });
  (async () => {
    const r = await window.petApi.ready(); cfg = { ...cfg, ...r.cfg }; state = { ...state, ...r.state }; applyVars(cfg.vars);
    if (r.bounds) { pos = { x: r.bounds.x, y: r.bounds.y, w: r.bounds.width, h: r.bounds.height }; wa = r.wa || wa; }
    refreshBounds();
    loadPet(); sizePet(); requestAnimationFrame(tick);
    setTimeout(() => say('If you need help, just let me know'), 2500);
  })();
})();