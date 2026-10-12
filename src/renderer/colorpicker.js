// Custom color picker (no native <input type=color>)
// ColorPicker.open(anchor, {value, alpha, onChange, onClose, swatches}) / .swatch(value, onChange, opts)
// ColorPicker.parse / .hex / .contrast / .toHsl / .fromHsl / .rgb2hsv / .hsv2rgb
(function () {
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const h2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

  // ---------- math ----------
  function parse(str) {
    if (str == null) return null;
    if (typeof str === 'object' && 'r' in str) return { r: str.r, g: str.g, b: str.b, a: str.a == null ? 1 : str.a };
    const s = String(str).trim().toLowerCase();
    let m = s.match(/^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
    if (m) {
      let x = m[1]; if (x.length <= 4) x = [...x].map((c) => c + c).join('');
      return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16), a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1 };
    }
    m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/);
    if (m) return { r: clamp(+m[1], 0, 255), g: clamp(+m[2], 0, 255), b: clamp(+m[3], 0, 255), a: m[4] == null ? 1 : clamp(m[5] ? m[4] / 100 : +m[4], 0, 1) };
    return null;
  }
  function rgb2hsv({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let hh = 0;
    if (d) { if (mx === r) hh = ((g - b) / d) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360; }
    return [hh, mx ? d / mx : 0, mx];
  }
  function hsv2rgb(hh, s, v) {
    hh = ((hh % 360) + 360) % 360; const c = v * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c; let r = 0, g = 0, b = 0;
    if (hh < 60) [r, g, b] = [c, x, 0]; else if (hh < 120) [r, g, b] = [x, c, 0]; else if (hh < 180) [r, g, b] = [0, c, x];
    else if (hh < 240) [r, g, b] = [0, x, c]; else if (hh < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }
  const rgbHex = ({ r, g, b }, a) => '#' + h2(r) + h2(g) + h2(b) + (a != null && a < 1 ? h2(a * 255) : '');
  const hex = (hh, s, v) => rgbHex(hsv2rgb(hh, s, v));
  // HSL helpers (s, l in 0..1)
  function toHsl(c) {
    const { r, g, b } = parse(c); const R = r / 255, G = g / 255, B = b / 255; const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2, d = mx - mn;
    let hh = 0, s = 0;
    if (d) { s = d / (1 - Math.abs(2 * l - 1)); if (mx === R) hh = ((G - B) / d) % 6; else if (mx === G) hh = (B - R) / d + 2; else hh = (R - G) / d + 4; hh *= 60; if (hh < 0) hh += 360; }
    return [hh, s, l];
  }
  function fromHsl(hh, s, l) {
    hh = ((hh % 360) + 360) % 360; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = l - c / 2; let r = 0, g = 0, b = 0;
    if (hh < 60) [r, g, b] = [c, x, 0]; else if (hh < 120) [r, g, b] = [x, c, 0]; else if (hh < 180) [r, g, b] = [0, c, x];
    else if (hh < 240) [r, g, b] = [0, x, c]; else if (hh < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
    return rgbHex({ r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) });
  }
  function lum(c) {
    const { r, g, b } = parse(c); const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrast(a, b) { const A = lum(a), B = lum(b); return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05); }

  // ---------- recent colors ----------
  const recent = () => (window.A && A.settings && Array.isArray(A.settings.recentColors) ? A.settings.recentColors : []);
  function pushRecent(c) {
    if (!window.A || !A.settings) return; c = c.slice(0, 7).toLowerCase();
    A.settings.recentColors = [c, ...recent().filter((x) => x !== c)].slice(0, 12); try { saveSettings(); } catch { }
  }
  const themeSwatches = () => {
    const th = window.THEMES && window.A && A.settings ? (THEMES.preview || THEMES[A.settings.theme]) : null; if (!th) return [];
    return [...Object.values(th.v), ...Object.values(th.t).map((x) => '#' + x)];
  };

  // ---------- popover ----------
  const ICO = {
    drop: '<svg class="ic" viewBox="0 0 24 24"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3z"/></svg>',
  };
  let live = null; // currently open picker
  function open(anchor, o = {}) {
    if (live) live.close();
    const init = parse(o.value) || { r: 0, g: 0, b: 0, a: 1 };
    let [H, S, V] = rgb2hsv(init); let Al = o.alpha ? init.a : 1;
    const startHex = rgbHex(init); let changed = false;
    const rgb = () => hsv2rgb(H, S, V);
    const out = () => rgbHex(rgb(), o.alpha ? Al : null);

    const mkSlider = (cls, label, get, set, max, step) => {
      const th = h('i', { class: 'cp-th' });
      const el = h('div', { class: 'cp-slider ' + cls, tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': max }, th);
      const fromEvt = (e) => { const r = el.getBoundingClientRect(); set(clamp((e.clientX - r.left) / r.width, 0, 1) * max); };
      el.addEventListener('pointerdown', (e) => { if (e.button) return; el.setPointerCapture(e.pointerId); el.focus(); fromEvt(e); update(true); e.preventDefault(); });
      el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) { fromEvt(e); update(true); } });
      el.addEventListener('keydown', (e) => {
        const k = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key]; if (!k) return; e.preventDefault();
        set(clamp(get() + k * step * (e.shiftKey ? 10 : 1), 0, max)); update(true);
      });
      el.th = th; return el;
    };

    // saturation / value square
    const svH = h('i', { class: 'cp-svh' });
    const sv = h('div', { class: 'cp-sv', tabindex: 0, role: 'slider', 'aria-label': 'Saturation and brightness' }, svH);
    const svFrom = (e) => { const r = sv.getBoundingClientRect(); S = clamp((e.clientX - r.left) / r.width, 0, 1); V = 1 - clamp((e.clientY - r.top) / r.height, 0, 1); };
    sv.addEventListener('pointerdown', (e) => { if (e.button) return; sv.setPointerCapture(e.pointerId); sv.focus(); svFrom(e); update(true); e.preventDefault(); });
    sv.addEventListener('pointermove', (e) => { if (sv.hasPointerCapture(e.pointerId)) { svFrom(e); update(true); } });
    sv.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key]; if (!d) return; e.preventDefault();
      const st = e.shiftKey ? 0.1 : 0.01; S = clamp(S + d[0] * st, 0, 1); V = clamp(V + d[1] * st, 0, 1); update(true);
    });
    const hue = mkSlider('cp-hue', 'Hue', () => H, (v) => (H = v), 360, 1);
    const alpha = o.alpha ? mkSlider('cp-alpha', 'Opacity', () => Al, (v) => (Al = v), 1, 0.01) : null;

    // fields
    const hexIn = h('input', { class: 'cp-in cp-hexin', spellcheck: 'false', maxlength: 9, 'aria-label': 'Hex' });
    const chip = h('i', { class: 'cp-prev' });
    const nums = {};
    const numField = (k, label, max) => {
      const inp = h('input', { class: 'cp-in cp-num', inputmode: 'numeric', 'aria-label': label });
      const apply = () => {
        const n = parseFloat(inp.value); if (isNaN(n)) { update(false); return; }
        const c = rgb(); if (k === 'a') Al = clamp(n / 100, 0, 1); else { c[k] = clamp(Math.round(n), 0, 255); setRgb(c); } update(true);
      };
      inp.addEventListener('change', apply);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { apply(); return; }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault();
        const n = (parseFloat(inp.value) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1); inp.value = clamp(n, 0, max); apply();
      });
      nums[k] = inp; return h('label', { class: 'cp-f' }, inp, h('span', null, label));
    };
    const setRgb = (c) => { const prevH = H; [H, S, V] = rgb2hsv(c); if (S === 0 || V === 0) H = prevH; };
    const commitHex = () => {
      const p = parse(hexIn.value);
      if (!p) { hexIn.classList.add('bad'); return false; }
      hexIn.classList.remove('bad'); setRgb(p); if (o.alpha && /^#?[0-9a-f]{8}$/i.test(hexIn.value.trim())) Al = p.a; update(true); return true;
    };
    hexIn.addEventListener('input', () => { hexIn.classList.toggle('bad', !parse(hexIn.value)); const p = parse(hexIn.value); if (p && /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.test(hexIn.value.trim())) { setRgb(p); update(true, hexIn); } });
    hexIn.addEventListener('change', () => { if (!commitHex()) update(false); });
    hexIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (commitHex()) hexIn.select(); } });
    hexIn.addEventListener('blur', () => { hexIn.classList.remove('bad'); update(false); });

    const eye = window.EyeDropper ? h('button', { class: 'cp-eye', type: 'button', title: 'Pick a color from the screen', html: ICO.drop, onclick: async () => {
      try { const r = await new EyeDropper().open(); const p = parse(r.sRGB || r.sRGBHex); if (p) { setRgb(p); update(true); } } catch { /* cancelled */ }
    } }) : null;

    // swatches
    const swWrap = h('div', { class: 'cp-sws' });
    const drawSw = () => {
      swWrap.innerHTML = ''; const seen = new Set();
      const add = (title, list) => {
        list = list.map((c) => { const p = parse(c); return p ? rgbHex(p) : null; }).filter((c) => c && !seen.has(c)); if (!list.length) return;
        list.forEach((c) => seen.add(c));
        swWrap.append(h('div', { class: 'cp-swt' }, title), h('div', { class: 'cp-swg' }, list.map((c) => h('button', { type: 'button', class: 'cp-sc', title: c, style: '--c:' + c, onclick: () => { setRgb(parse(c)); update(true); } }))));
      };
      add('Recent', recent()); add('Suggested', [...(o.swatches || [])]); add('Theme', themeSwatches());
    };

    const pop = h('div', { class: 'combo-pop cp-pop', role: 'dialog', 'aria-label': 'Color picker' },
      sv, h('div', { class: 'cp-sliders' }, hue, alpha),
      h('div', { class: 'cp-hexrow' }, eye, chip, hexIn),
      h('div', { class: 'cp-rgb' }, numField('r', 'R', 255), numField('g', 'G', 255), numField('b', 'B', 255), o.alpha ? numField('a', 'A%', 100) : null),
      swWrap);
    document.body.append(pop); drawSw();

    function update(fire, skip) {
      const c = rgb(), full = rgbHex(c);
      pop.style.setProperty('--hue', `hsl(${H} 100% 50%)`); pop.style.setProperty('--cur', full);
      svH.style.left = S * 100 + '%'; svH.style.top = (1 - V) * 100 + '%'; svH.style.background = full;
      hue.th.style.left = (H / 360) * 100 + '%'; hue.th.style.background = `hsl(${H} 100% 50%)`; hue.setAttribute('aria-valuenow', Math.round(H));
      if (alpha) { alpha.th.style.left = Al * 100 + '%'; alpha.th.style.background = full; alpha.style.setProperty('--cur', full); alpha.setAttribute('aria-valuenow', Math.round(Al * 100)); }
      sv.setAttribute('aria-valuetext', `Saturation ${Math.round(S * 100)}%, brightness ${Math.round(V * 100)}%`);
      chip.style.setProperty('--c', o.alpha ? rgbHex(c, Al) : full);
      if (skip !== hexIn && document.activeElement !== hexIn) hexIn.value = out();
      else if (skip !== hexIn) hexIn.value = out();
      for (const k of ['r', 'g', 'b']) if (document.activeElement !== nums[k]) nums[k].value = c[k];
      if (nums.a && document.activeElement !== nums.a) nums.a.value = Math.round(Al * 100);
      if (fire) { changed = true; o.onChange && o.onChange(out()); }
    }
    update(false);

    // position
    const place = () => {
      const r = anchor.getBoundingClientRect(), pr = pop.getBoundingClientRect(), avoid = anchor.closest('[data-cp-avoid]');
      let left, top;
      if (avoid) { const ar = avoid.getBoundingClientRect(); left = ar.left - pr.width - 10; top = r.top + r.height / 2 - pr.height / 2; if (left < 8) left = r.left - pr.width - 10; }
      else { left = r.left; top = r.bottom + 6; if (top + pr.height > innerHeight - 8) top = r.top - pr.height - 6; }
      pop.style.left = clamp(left, 8, Math.max(8, innerWidth - pr.width - 8)) + 'px'; pop.style.top = clamp(top, 8, Math.max(8, innerHeight - pr.height - 8)) + 'px';
    };
    place();

    const off = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); anchor.focus && anchor.focus(); } };
    const rs = () => close();
    setTimeout(() => { addEventListener('mousedown', off, true); addEventListener('keydown', key, true); addEventListener('resize', rs); }, 0);
    anchor.classList.add('open'); setTimeout(() => sv.focus({ preventScroll: true }), 20);
    function close() {
      if (!pop.isConnected && live !== api) return;
      pop.remove(); removeEventListener('mousedown', off, true); removeEventListener('keydown', key, true); removeEventListener('resize', rs);
      anchor.classList.remove('open'); if (live === api) live = null;
      if (changed) pushRecent(rgbHex(rgb())); o.onClose && o.onClose();
    }
    const api = { close, anchor, set(v) { const p = parse(v); if (p) { setRgb(p); if (o.alpha) Al = p.a; update(false); } } };
    live = api; return api;
  }

  // ---------- swatch button ----------
  function swatch(value, onChange, opts = {}) {
    let cur = value;
    const chip = h('i', { class: 'cp-chip' }), lab = opts.label === false ? null : h('span', { class: 'cp-hex' });
    const btn = h('button', { type: 'button', class: 'cp-sw' + (opts.cls ? ' ' + opts.cls : '') + (lab ? '' : ' bare'), title: opts.title || 'Choose color', 'aria-label': opts.title || 'Choose color' }, chip, lab);
    const paint = () => { const p = parse(cur); chip.style.setProperty('--c', p ? rgbHex(p, p.a) : 'transparent'); if (lab) lab.textContent = p ? String(cur).replace(/^#?/, '#').toLowerCase() : '—'; };
    btn.addEventListener('click', () => {
      if (live && live.anchor === btn) { live.close(); return; }
      open(btn, { value: cur, alpha: opts.alpha, swatches: opts.swatches, onChange: (v) => { cur = v; paint(); onChange && onChange(v); }, onClose: opts.onClose });
    });
    btn.set = (v) => { cur = v; paint(); if (live && live.anchor === btn) live.set(v); };
    Object.defineProperty(btn, 'value', { get: () => cur });
    paint(); return btn;
  }

  window.ColorPicker = { open, swatch, parse, hex, contrast, rgb2hsv, hsv2rgb, toHsl, fromHsl, toHex: rgbHex, close: () => live && live.close() };
})();
