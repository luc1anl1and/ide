// IDE side of the desktop pet: tells the pet what every chat is doing, shows events as speech bubbles,
// and carries out what the pet asks for (send a prompt, open a chat, stop a chat).
(function () {
  const on = () => !!(A.settings && A.settings.pet && A.settings.pet.enabled !== false);
  const stateOf = (c) => (c.running ? 'working' : c.pendingPerms ? 'approval' : c._done === 'fail' ? 'failed' : c._done ? 'ready' : 'idle');
  let timer = null, provSig = '';
  function build() {
    const out = {
      active: A.activeChat && A.activeChat.id, ws: A.ws ? basename(A.ws) : '',
      chats: A.chats.filter((c) => c.sessionId || c.running || c.title !== 'New chat' || c === A.activeChat).map((c) => ({ id: c.id, title: c.title, provider: c.cfg.provider, state: stateOf(c), phase: c._phase || '', cost: c.cost || 0, tokens: c.tokens ? (c.tokens.input || 0) + (c.tokens.output || 0) : 0, since: c.runStart || 0 })),
    };
    // approvals waiting in any chat: the pet shows Allow / Deny buttons for them
    out.perms = []; for (const c of A.chats) if (c.petPerms) for (const p of c.petPerms.values()) out.perms.push({ chatId: c.id, id: p.id, kind: p.kind, title: p.title, sum: p.sum, options: p.options || null, always: !!p.always, provider: c.cfg.provider, chatTitle: c.title });
    const sig = PROV_IDS.join(',');
    if (sig !== provSig) { provSig = sig; out.providers = PROV_IDS.map((id) => ({ id, name: PROV[id].name, logo: PROV[id].logo })); }
    return out;
  }
  const themeVars = () => { const cs = getComputedStyle(document.documentElement); const o = {}; for (const k of ['--bg', '--bg1', '--bg2', '--bg3', '--fg', '--fg2', '--fg3', '--hair', '--accent', '--bad', '--warn', '--ui-font', '--mono']) o[k] = cs.getPropertyValue(k).trim(); return o; };

  const PetBridge = {
    sync() { if (!on()) return; clearTimeout(timer); timer = setTimeout(() => { try { api.pet.state(build()); } catch { } }, 150); },
    apply() { try { provSig = ''; api.pet.config({ ...(A.settings.pet || {}), vars: themeVars() }); this.sync(); } catch { } },
    async handle({ fn, text, provider, chatId, id, action, value }) {
      const c = chatId && A.chats.find((x) => x.id === chatId);
      if (fn === 'perm') { const rec = c && c.petPerms && c.petPerms.get(id); if (!rec) return; if (action === 'allow' && rec.allow) rec.allow(); else if (action === 'always' && rec.always) rec.always(); else if (action === 'answer' && rec.answer) rec.answer(value); else if (action === 'deny') rec.deny(); this.sync(); return; }
      if (fn === 'open') { if (c) Chat.select(c); App.toggleChat(true); return; }
      if (fn === 'interrupt') { if (c) Chat.interrupt(c); return; }
      if (fn === 'prompt') {
        let t = c; if (!t) t = Chat.new({ provider: provider || A.settings.provider });
        else Chat.select(t);
        t._done = false; Chat.sendNow(String(text || '')); this.sync();
      }
    },
  };
  window.PetBridge = PetBridge;

  // chat.js calls this: true/false = started/stopped working, 'perm', 'done', 'fail'
  window.petHook = (c, what) => {
    if (!on()) return;
    const base = { chatId: c.id, title: c.title, provider: c.cfg.provider, name: PROV[c.cfg.provider].name };
    if (what === true) { c._done = false; c.runStart = Date.now(); api.pet.event({ kind: 'start', ...base }); }
    else if (what === 'perm') api.pet.event({ kind: 'perm', ...base });
    else if (what === 'done') { c._done = true; api.pet.event({ kind: 'done', ...base }); }
    else if (what === 'fail') { c._done = 'fail'; api.pet.event({ kind: 'fail', ...base }); }
    PetBridge.sync();
  };

  document.addEventListener('DOMContentLoaded', () => {
    if (window.__POP) return;
    setTimeout(() => { if (window.api && api.on) { api.on('pet:cmd', (o) => PetBridge.handle(o || {})); PetBridge.apply(); } }, 800);
  });
})();