// Custom form controls (no native <select>/<input type=number>) + system font access
(function () {
  const norm = (opts) => opts.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : o));

  // ---------- dropdown ----------
  // options: [[value,label]] or [{value,label,sub,icon,group,fontFamily}]
  window.Sel = function (options, value, onChange, o = {}) {
    let items = norm(options), cur = value;
    const label = h('span', { class: 'dd-l' }); const btn = h('button', { class: 'dd ' + (o.cls || ''), type: 'button', style: o.width ? { width: o.width } : null }, label, h('span', { class: 'dd-car', html: icon('chevDown') }));
    const paint = () => { const it = items.find((x) => x.value === cur); label.textContent = it ? it.label : (o.placeholder || String(cur ?? '')); label.style.fontFamily = it && it.fontFamily ? it.fontFamily : ''; };
    btn.addEventListener('click', () => Combo.open(btn, { items, value: cur, width: Math.max(btn.offsetWidth, o.menuWidth || 200), search: o.search, title: o.title, onPick: (v) => { cur = v; paint(); onChange && onChange(v); btn.dispatchEvent(new Event('change')); } }));
    btn.set = (v) => { cur = v; paint(); }; btn.setItems = (list) => { items = norm(list); paint(); };
    Object.defineProperty(btn, 'value', { get: () => cur, set: (v) => { cur = v; paint(); } });
    paint(); return btn;
  };

  // ---------- number stepper ----------
  window.Stepper = function ({ value, min = 0, max = 100, step = 1, unit = '', decimals }, onChange) {
    const dec = decimals ?? (String(step).split('.')[1] || '').length;
    let v = +value;
    const inp = h('input', { class: 'stp-in', value: v.toFixed(dec), inputmode: 'decimal' });
    const set = (x, fire = true) => { x = Math.min(max, Math.max(min, Math.round(x / step) * step)); v = +x.toFixed(dec); inp.value = v.toFixed(dec); fire && onChange && onChange(v); };
    inp.addEventListener('change', () => { const n = parseFloat(inp.value.replace(',', '.')); isNaN(n) ? set(v, false) : set(n); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp') { e.preventDefault(); set(v + step); } else if (e.key === 'ArrowDown') { e.preventDefault(); set(v - step); } });
    const el = h('div', { class: 'stp' }, h('button', { type: 'button', html: icon('minus'), onclick: () => set(v - step) }), inp, unit ? h('span', { class: 'stp-u' }, unit) : null, h('button', { type: 'button', html: icon('plus'), onclick: () => set(v + step) }));
    el.set = (x) => set(x, false); return el;
  };

  // ---------- fonts ----------
  const Fonts = { list: null, mono: new Set(), loading: null };
  const cv = document.createElement('canvas').getContext('2d');
  function isMono(family) {
    cv.font = `16px "${family}", monospace`; const a = cv.measureText('iiiiiiii').width, b = cv.measureText('WWWWWWWW').width;
    cv.font = '16px monospace'; const m = cv.measureText('iiiiiiii').width; // fallback guard
    return Math.abs(a - b) < 0.5 && a !== m * 1;
  }
  Fonts.load = async function (force) {
    if (Fonts.list && !force) return Fonts.list;
    if (Fonts.loading && !force) return Fonts.loading;
    Fonts.loading = (async () => {
      let fam = [];
      try { const all = await window.queryLocalFonts(); fam = [...new Set(all.map((f) => f.family))]; } catch { /* permission or API missing */ }
      if (!fam.length) { try { fam = await api.fonts.list(); } catch { fam = []; } }
      (A.settings.userFonts || []).forEach((u) => { if (!fam.includes(u.family)) fam.push(u.family); });
      fam = [...new Set(fam)].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      Fonts.mono = new Set(fam.filter((f) => { try { return isMono(f); } catch { return false; } }));
      Fonts.list = fam; return fam;
    })();
    return Fonts.loading;
  };
  // minimal TTF/OTF/WOFF name-table reader → family name
  function familyOf(buf) {
    const dv = new DataView(buf); const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    let base = 0; if (tag(0) === 'ttcf') base = dv.getUint32(12);
    const n = dv.getUint16(base + 4); let nameOff = 0;
    for (let i = 0; i < n; i++) { const r = base + 12 + i * 16; if (tag(r) === 'name') { nameOff = dv.getUint32(r + 8); break; } }
    if (!nameOff) return null;
    const count = dv.getUint16(nameOff + 2), strOff = nameOff + dv.getUint16(nameOff + 4); const found = {};
    for (let i = 0; i < count; i++) {
      const r = nameOff + 6 + i * 12; const plat = dv.getUint16(r), id = dv.getUint16(r + 6), len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
      if (id !== 1 && id !== 16) continue;
      let s = ''; const p = strOff + off;
      if (plat === 3 || plat === 0) for (let k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(p + k)); else for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint8(p + k));
      if (s && (!found[id] || plat === 3)) found[id] = s;
    }
    return found[16] || found[1] || null;
  }
  Fonts.installFiles = async function (paths) {
    const done = [];
    for (const p of paths) {
      const f = await api.fs.readBytes(p); const buf = f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength);
      let fam = null; try { fam = familyOf(buf); } catch { }
      fam = fam || f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      const r = await api.fonts.install(p); if (!r.ok) { toast('Could not install ' + f.name + ': ' + r.error, true); continue; }
      try { const ff = new FontFace(fam, buf); await ff.load(); document.fonts.add(ff); } catch { }
      const list = (A.settings.userFonts = A.settings.userFonts || []); if (!list.find((x) => x.family === fam)) list.push({ family: fam, path: r.path });
      done.push(fam);
    }
    if (done.length) { saveSettings(); Fonts.list = null; await Fonts.load(true); }
    return done;
  };
  // load fonts the user installed through the app (so they work even before Windows refreshes its font cache)
  Fonts.loadUser = async function () {
    for (const u of A.settings.userFonts || []) { try { const r = await api.fs.readBytes(u.path); const ff = new FontFace(u.family, r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength)); await ff.load(); document.fonts.add(ff); } catch { } }
  };

  // ---------- font picker ----------
  // key: settings key holding the CSS font-family string; o: {mono, def (default family string), onChange}
  window.FontPicker = function (key, o = {}) {
    const first = (v) => String(v || '').split(',')[0].replace(/["']/g, '').trim();
    const label = h('span', { class: 'dd-l' }); const btn = h('button', { class: 'dd font', type: 'button', style: { width: '230px' } }, label, h('span', { class: 'dd-car', html: icon('chevDown') }));
    const paint = () => { const v = A.settings[key] || o.def || ''; label.textContent = first(v) || 'Default'; label.style.fontFamily = v; };
    btn.addEventListener('click', async () => {
      const fams = await Fonts.load(); const cur = first(A.settings[key] || o.def);
      const mk = (f, g) => ({ value: f, label: f, fontFamily: `"${f}"`, group: g });
      const monos = fams.filter((f) => Fonts.mono.has(f)), rest = fams.filter((f) => !Fonts.mono.has(f));
      const items = [{ value: '__default', label: 'Default', sub: first(o.def) || 'System', group: '' }, ...(o.mono ? [...monos.map((f) => mk(f, 'Monospace')), ...rest.map((f) => mk(f, 'All fonts'))] : [...fams.map((f) => mk(f, ''))]), { value: '__install', label: 'Install a font…', sub: 'Add a .ttf / .otf to Windows and Reva', group: 'More' }];
      Combo.open(btn, { items, value: cur, search: true, width: 320, title: 'Font', onPick: async (v) => {
        if (v === '__install') { const files = await api.dialog.fonts(); if (!files || !files.length) return; const done = await Fonts.installFiles(files); if (done.length) { toast('Installed ' + done.join(', ') + ' — available in Windows and here'); setSetting(key, `"${done[0]}", ${o.mono ? 'monospace' : 'sans-serif'}`); paint(); } return; }
        setSetting(key, v === '__default' ? (o.def || '') : `"${v}", ${o.mono ? 'monospace' : 'sans-serif'}`); paint(); o.onChange && o.onChange();
      } });
    });
    btn.repaint = paint; paint(); return btn;
  };
  window.Fonts = Fonts;
})();
