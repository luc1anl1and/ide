// Theme editor: right-side drawer with live preview in the real UI.
// window.openThemeEditor(id, done) -- id null = new theme.
(function () {
  const CP = () => window.ColorPicker;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const GROUPS = [
    { title: 'Surfaces', kind: 'v', rows: [['bg', 'Canvas'], ['bg1', 'Panels'], ['bg2', 'Raised'], ['bg3', 'Hover / selected'], ['border', 'Borders']] },
    { title: 'Text', kind: 'v', contrast: true, rows: [['fg', 'Primary'], ['fg2', 'Secondary'], ['fg3', 'Muted']] },
    { title: 'Accent', kind: 'v', rows: [['accent', 'Accent'], ['accent2', 'Accent (light)']] },
    { title: 'Syntax', kind: 't', contrast: true, rows: [['keyword', 'Keyword'], ['string', 'String'], ['number', 'Number'], ['comment', 'Comment'], ['type', 'Type'], ['func', 'Function'], ['variable', 'Variable'], ['operator', 'Operator']] },
  ];
  const V_KEYS = ['bg', 'bg1', 'bg2', 'bg3', 'border', 'fg', 'fg2', 'fg3', 'accent', 'accent2'];
  const T_KEYS = ['keyword', 'string', 'number', 'comment', 'type', 'func', 'variable', 'operator'];
  const svg = (p) => `<svg class="ic" viewBox="0 0 24 24">${p}</svg>`;
  const ICO = {
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    dice: svg('<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/><circle cx="15" cy="9" r="1.1" fill="currentColor"/><circle cx="9" cy="15" r="1.1" fill="currentColor"/>'),
    wand: svg('<path d="m4 20 11-11"/><path d="m13 7 4 4"/><path d="M18 3v3M16.5 4.5h3M20 11v2M19 12h2M8 3v2M7 4h2"/>'),
    paste: svg('<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/>'),
  };

  // ---------- palette generation ----------
  function ensure(c, bg, min, dark) {
    let [hh, s, l] = CP().toHsl(c), out = c;
    for (let i = 0; i < 40 && CP().contrast(out, bg) < min; i++) { l = clamp(l + (dark ? 0.02 : -0.02), 0, 1); out = CP().fromHsl(hh, s, l); }
    return out;
  }
  function generate(accent, dark) {
    const f = CP().fromHsl, [h0, s0, l0] = CP().toHsl(accent);
    const ts = clamp(s0 * 0.4, 0.1, 0.32) * (dark ? 1 : 1.1);
    const L = dark ? [0.06, 0.09, 0.13, 0.18, 0.17] : [0.98, 0.95, 0.91, 0.86, 0.84];
    const [bg, bg1, bg2, bg3, border] = L.map((l) => f(h0, ts, l));
    const fg = f(h0, dark ? 0.25 : 0.35, dark ? 0.92 : 0.13);
    const fg2 = ensure(f(h0, dark ? 0.14 : 0.22, dark ? 0.68 : 0.34), bg, 4.5, dark);
    const fg3 = ensure(f(h0, dark ? 0.1 : 0.16, dark ? 0.46 : 0.5), bg, 3, dark);
    const acc = CP().toHex(CP().parse(accent));
    const accent2 = f(h0 + 24, clamp(s0, 0.5, 1), dark ? clamp(l0 + 0.14, 0.62, 0.82) : clamp(l0 - 0.1, 0.3, 0.5));
    const sy = (dh, sat = dark ? 0.75 : 0.65) => ensure(f(h0 + dh, sat, dark ? 0.74 : 0.36), bg, 4.5, dark);
    const t = { keyword: sy(0), string: sy(135), number: sy(35), comment: ensure(f(h0, 0.2, 0.5), bg, 3, dark), type: sy(190), func: sy(75), variable: fg, operator: sy(305) };
    for (const k in t) t[k] = t[k].slice(1);
    return { dark, v: { bg, bg1, bg2, bg3, border, fg, fg2, fg3, accent: acc, accent2 }, t };
  }
  function randomAccent(dark) {
    return CP().fromHsl(Math.random() * 360, 0.55 + Math.random() * 0.3, dark ? 0.58 + Math.random() * 0.08 : 0.42 + Math.random() * 0.08);
  }
  const normHex = (c) => { const p = CP().parse(c); return p ? CP().toHex(p) : null; };

  window.openThemeEditor = function (id, done) {
    const s = A.settings, prev = s.theme;
    const src = (id && THEMES[id]) || THEMES[s.theme] || THEMES.amethyst;
    const th = JSON.parse(JSON.stringify({ name: src.name, dark: !!src.dark, v: src.v, t: src.t }));
    const uniq = (base) => { const names = new Set(Object.entries(THEMES).filter(([k]) => k !== 'preview').map(([, t]) => t.name.toLowerCase())); let n = base, i = 2; while (names.has(n.toLowerCase())) n = base.replace(/ \d+$/, '') + ' ' + i++; return n; };
    if (!id) th.name = uniq((src.name || 'Theme') + ' copy');
    const snap = () => JSON.stringify({ d: th.dark, v: th.v, t: th.t });
    const initial = snap(), initialName = th.name;
    let history = [], burst = false, burstT = 0, saved = false, closed = false;
    const touch = () => { if (!burst) { history.push(snap()); if (history.length > 80) history.shift(); } burst = true; clearTimeout(burstT); burstT = setTimeout(() => (burst = false), 500); syncBtns(); };
    const restore = (j) => { const o = JSON.parse(j); th.dark = o.d; th.v = o.v; th.t = o.t; refreshAll(); };

    // ---------- live preview in the real UI ----------
    let mt = 0;
    const monacoApply = () => { if (window.monaco && window.__monacoReady) { defineMonacoThemes(monaco, null); monaco.editor.setTheme('am-preview'); } };
    const apply = () => {
      THEMES.preview = th; applyTheme('preview', null); paintPreview();
      try { api.win.overlay({ color: th.v.bg, symbolColor: th.v.fg2 }); } catch { }
      clearTimeout(mt); mt = setTimeout(monacoApply, 90);
    };

    // ---------- mini preview card ----------
    const reg = []; const sty = (el, fn) => { reg.push([el, fn]); return el; };
    const tok = (k, txt) => sty(h('span', null, txt), () => ({ color: '#' + th.t[k] }));
    const line = (n, ...parts) => h('div', { class: 'te-ln' }, sty(h('i', null, n), () => ({ color: th.v.fg3 })), h('span', null, parts));
    const onAccent = () => (CP().contrast(th.v.accent, '#ffffff') >= CP().contrast(th.v.accent, '#000000') ? '#ffffff' : '#000000');
    const sideItem = (on, w) => sty(h('div', { class: 'te-si' }, sty(h('i', { style: { width: w } }), () => ({ background: on ? th.v.fg : th.v.fg3, opacity: on ? 0.8 : 0.5 }))), () => ({ background: on ? th.v.bg3 : 'transparent' }));
    const preview = sty(h('div', { class: 'te-pv' },
      sty(h('div', { class: 'te-pv-side' },
        h('div', { class: 'te-pv-brand' }, sty(h('b'), () => ({ background: th.v.accent })), sty(h('i'), () => ({ background: th.v.fg2, opacity: 0.7 }))),
        sideItem(true, '70%'), sideItem(false, '55%'), sideItem(false, '64%')), () => ({ background: th.v.bg1, borderRight: '1px solid ' + th.v.border })),
      h('div', { class: 'te-pv-main' },
        sty(h('div', { class: 'te-pv-code' },
          line(1, tok('comment', '// live preview')),
          line(2, tok('keyword', 'const '), tok('variable', 'theme '), tok('operator', '= '), tok('func', 'load'), tok('operator', '('), tok('string', '"amy"'), tok('operator', ')')),
          line(3, tok('keyword', 'class '), tok('type', 'Panel '), tok('operator', '{ '), tok('func', 'render'), tok('operator', '('), tok('variable', 'n'), tok('operator', ') '), tok('number', '42'), tok('operator', ' }'))), () => ({ background: th.v.bg })),
        sty(h('div', { class: 'te-pv-chat' },
          sty(h('div', { class: 'te-pv-bub' }, sty(h('i', { style: { width: '78%' } }), () => ({ background: th.v.fg })), sty(h('i', { style: { width: '52%' } }), () => ({ background: th.v.fg2 }))), () => ({ background: th.v.bg3 })),
          sty(h('div', { class: 'te-pv-btn' }, 'Run'), () => ({ background: th.v.accent, color: onAccent() })),
          sty(h('span', { class: 'te-pv-link' }, 'link'), () => ({ color: th.v.accent2 }))), () => ({ background: th.v.bg1, borderTop: '1px solid ' + th.v.border }))),
    ), () => ({ background: th.v.bg, border: '1px solid ' + th.v.border }));
    function paintPreview() { for (const [el, fn] of reg) Object.assign(el.style, fn()); }

    // ---------- header ----------
    const nameErr = h('div', { class: 'te-err' });
    const name = h('input', { class: 'te-name', value: th.name, spellcheck: 'false', placeholder: 'Theme name', maxlength: 40, 'aria-label': 'Theme name', oninput: () => { th.name = name.value; validate(); syncBtns(); } });
    const validate = () => {
      const n = name.value.trim(); let msg = '';
      if (!n) msg = 'Give your theme a name';
      else if (Object.entries(THEMES).some(([k, t]) => k !== 'preview' && k !== id && t.name.trim().toLowerCase() === n.toLowerCase())) msg = 'A theme with this name already exists';
      nameErr.textContent = msg; name.classList.toggle('bad', !!msg); return !msg;
    };
    const closeBtn = h('button', { class: 'icon-btn', title: 'Close', html: icon('x'), onclick: () => tryClose() });

    // ---------- controls ----------
    const modeBtn = (dark, label) => h('button', { type: 'button', class: th.dark === dark ? 'on' : '', onclick: () => { if (th.dark === dark) return; touch(); th.dark = dark; syncMode(); apply(); } }, label);
    const bDark = modeBtn(true, 'Dark'), bLight = modeBtn(false, 'Light');
    const mode = h('div', { class: 'seg te-seg' }, bDark, bLight);
    const syncMode = () => { bDark.classList.toggle('on', th.dark); bLight.classList.toggle('on', !th.dark); };
    const startFrom = Sel(Object.entries(THEMES).filter(([k]) => k !== 'preview').map(([k, t]) => [k, t.name]), '', (v) => {
      if (!v) return; const b = THEMES[v]; touch(); th.v = JSON.parse(JSON.stringify(b.v)); th.t = JSON.parse(JSON.stringify(b.t)); th.dark = b.dark; refreshAll(); startFrom.set('');
    }, { width: '100%', placeholder: 'Start from…', search: true, menuWidth: 220, cls: 'te-dd' });

    // ---------- generate ----------
    let seed = th.v.accent;
    const seedSw = CP().swatch(seed, (v) => (seed = v), { title: 'Seed accent' });
    const gen = (accent) => { touch(); const g = generate(accent, th.dark); th.v = g.v; th.t = g.t; refreshAll(); };
    const genBtn = h('button', { class: 'btn te-gen', type: 'button', onclick: () => gen(seed) }, h('span', { html: ICO.wand }), 'Generate');
    const rndBtn = h('button', { class: 'btn te-rnd', type: 'button', title: 'Random palette', onclick: () => { seed = randomAccent(th.dark); seedSw.set(seed); gen(seed); } }, h('span', { html: ICO.dice }), 'Randomize');
    const genCard = h('div', { class: 'te-card te-gcard' }, h('div', { class: 'te-gt' }, h('b', null, 'Generate from accent'), h('small', null, 'Pick one color, get a matching palette for the current mode.')),
      h('div', { class: 'te-gr' }, seedSw, genBtn, rndBtn));

    // ---------- color rows ----------
    const rowRefs = [];
    const badge = (c, bg) => {
      const r = CP().contrast(c, bg); const lab = r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : r >= 3 ? 'AA large' : 'Fail';
      return [lab, r.toFixed(1), r >= 7 ? 'hi' : r >= 4.5 ? 'ok' : r >= 3 ? 'mid' : 'bad'];
    };
    const getC = (kind, k) => (kind === 'v' ? th.v[k] : '#' + th.t[k]);
    const groupEls = GROUPS.map((g) => {
      const card = h('div', { class: 'te-card' });
      g.rows.forEach(([k, label]) => {
        const bd = g.contrast ? h('span', { class: 'te-bd' }) : null;
        const sw = CP().swatch(getC(g.kind, k), (v) => {
          touch(); if (g.kind === 'v') th.v[k] = v.slice(0, 7).toLowerCase(); else th.t[k] = v.slice(1, 7).toLowerCase(); apply(); paintBadges();
        }, { title: label });
        const row = h('div', { class: 'te-row', onclick: (e) => { if (!sw.contains(e.target)) sw.click(); } }, h('span', { class: 'te-l' }, label), bd, sw);
        rowRefs.push({ g, k, sw, bd }); card.append(row);
      });
      return h('div', { class: 'te-grp' }, h('div', { class: 'te-gh' }, g.title), card);
    });
    function paintBadges() {
      for (const r of rowRefs) if (r.bd) {
        const [lab, ratio, cls] = badge(getC(r.g.kind, r.k), th.v.bg);
        r.bd.className = 'te-bd ' + cls; r.bd.textContent = lab; r.bd.title = `Contrast vs canvas: ${ratio}:1`;
        r.bd.dataset.ratio = ratio;
      }
    }
    function refreshAll() { rowRefs.forEach((r) => r.sw.set(getC(r.g.kind, r.k))); seed = th.v.accent; seedSw.set(seed); syncMode(); paintBadges(); apply(); syncBtns(); }

    // ---------- json ----------
    const copyJson = () => { const j = JSON.stringify({ name: th.name.trim(), dark: th.dark, v: th.v, t: th.t }); (navigator.clipboard ? navigator.clipboard.writeText(j) : Promise.reject()).then(() => toast('Theme JSON copied'), () => toast('Could not copy', true)); };
    const applyJson = (txt) => {
      let o; try { o = JSON.parse(txt); } catch { toast('That is not valid JSON', true); return false; }
      if (!o || typeof o.v !== 'object') { toast('Theme JSON needs a "v" object', true); return false; }
      const v = { ...th.v }, t = { ...th.t };
      for (const k of V_KEYS) if (o.v[k] != null) { const n = normHex(o.v[k]); if (!n) { toast('Invalid color for ' + k, true); return false; } v[k] = n.slice(0, 7); }
      if (o.t && typeof o.t === 'object') for (const k of T_KEYS) if (o.t[k] != null) { const n = normHex(o.t[k]); if (!n) { toast('Invalid color for ' + k, true); return false; } t[k] = n.slice(1, 7); }
      touch(); th.v = v; th.t = t; if (typeof o.dark === 'boolean') th.dark = o.dark;
      if (typeof o.name === 'string' && o.name.trim() && !id) { name.value = uniq(o.name.trim()); th.name = name.value; validate(); }
      refreshAll(); toast('Theme pasted'); return true;
    };
    const pasteJson = async () => {
      let txt = ''; try { txt = await navigator.clipboard.readText(); } catch { }
      if (txt && txt.trim().startsWith('{') && applyJson(txt)) return;
      const j = await promptBox('Paste theme JSON', '', '{ "v": { ... }, "t": { ... } }'); if (j) applyJson(j);
    };

    // ---------- footer ----------
    const undoBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Undo', html: ICO.undo, onclick: () => { const j = history.pop(); if (j) { burst = false; restore(j); } syncBtns(); } });
    const resetBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Reset to the state when you opened the editor', html: ICO.reset, onclick: () => { if (snap() === initial) return; touch(); restore(initial); } });
    const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => save() }, 'Save');
    const dirty = () => snap() !== initial || name.value.trim() !== initialName.trim();
    function syncBtns() { undoBtn.disabled = !history.length; resetBtn.disabled = snap() === initial; saveBtn.disabled = !name.value.trim(); }
    const save = () => {
      if (!validate()) { name.focus(); return; }
      th.name = name.value.trim(); const tid = id || 'c-' + Date.now().toString(36);
      const out = { name: th.name, dark: th.dark, v: { ...th.v }, t: { ...th.t } };
      (s.customThemes = s.customThemes || {})[tid] = out; THEMES[tid] = out; saved = true;
      shutdown(); setSetting('theme', tid); saveSettings(); toast('Theme saved'); done && done();
    };

    // ---------- shell ----------
    const body = h('div', { class: 'te-body' }, preview,
      h('div', { class: 'te-ctl' }, mode, startFrom), genCard, groupEls,
      h('div', { class: 'te-share' }, h('button', { class: 'btn sm', type: 'button', onclick: copyJson }, h('span', { html: icon('copy') }), 'Copy JSON'), h('button', { class: 'btn sm', type: 'button', onclick: pasteJson }, h('span', { html: ICO.paste }), 'Paste JSON')));
    let foot;
    const keepEditing = () => { discardBar.remove(); foot.style.display = ''; };
    const discardBar = h('div', { class: 'te-foot te-discard' }, h('span', { class: 'te-dtxt' }, 'Discard your changes?'), h('span', { style: { flex: 1 } }), h('button', { class: 'btn', type: 'button', onclick: () => keepEditing() }, 'Keep editing'), h('button', { class: 'btn danger', type: 'button', onclick: () => shutdown() }, 'Discard'));
    const drawer = h('div', { class: 'te-drawer', 'data-cp-avoid': '', role: 'dialog', 'aria-label': 'Theme editor' },
      h('div', { class: 'te-head' }, h('div', { class: 'te-nw' }, h('span', { class: 'te-pen', html: icon('edit') }), name), closeBtn), nameErr, body,
      foot = h('div', { class: 'te-foot' }, undoBtn, resetBtn, h('span', { style: { flex: 1 } }), h('button', { class: 'btn', type: 'button', onclick: () => tryClose() }, 'Cancel'), saveBtn));
    const scrim = h('div', { class: 'te-scrim' }, drawer);
    $('#overlay-root').append(scrim);

    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (discardBar.isConnected) keepEditing(); else tryClose(); } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !(e.target && e.target.tagName === 'INPUT')) { e.preventDefault(); undoBtn.click(); } };
    document.addEventListener('keydown', onKey, true);
    function shutdown() {
      if (closed) return; closed = true; clearTimeout(mt); ColorPicker.close();
      scrim.remove(); document.removeEventListener('keydown', onKey, true);
      if (!saved) { delete THEMES.preview; applySettings('theme'); } else delete THEMES.preview;
    }
    async function tryClose() {
      if (closed) return;
      if (dirty()) { if (!discardBar.isConnected) { foot.style.display = 'none'; drawer.append(discardBar); discardBar.querySelector('.btn').focus(); } return; }
      shutdown();
    }

    validate(); paintBadges(); syncBtns(); apply();
    setTimeout(() => { if (!id) { name.focus(); name.select(); } }, 60);
    return { close: shutdown };
  };
})();
