// Popover dropdowns with icons, groups, search
window.Combo = {
  closeAll() { if (Combo._cur) Combo._cur.close(); $$('.combo-pop').forEach((e) => e.remove()); },
  // items: [{value,label,sub,icon(html),group,badge,disabled,hint}]
  open(anchor, opts) {
    if (Combo._cur && Combo._cur.anchor === anchor && document.body.contains(Combo._cur.pop)) { Combo._cur.close(); return { close() {} }; } // clicking the opener again closes it
    Combo.closeAll();
    const { items, value, onPick, search, width, align = 'left', footer, title } = opts;
    const pop = h('div', { class: 'combo-pop', style: { minWidth: (width || Math.max(anchor.offsetWidth, 220)) + 'px' } });
    const list = h('div', { class: 'combo-list' });
    let q = '', idx = Math.max(0, items.findIndex((i) => i.value === value));
    let shown = items;
    const draw = () => {
      list.innerHTML = ''; let lastGroup = null;
      shown.forEach((it, i) => {
        if (it.group && it.group !== lastGroup) { list.append(h('div', { class: 'combo-group' }, it.group)); lastGroup = it.group; }
        const row = h('div', { class: 'combo-item' + (it.value === value ? ' sel' : '') + (i === idx ? ' hl' : '') + (it.disabled ? ' dis' : ''),
          onclick: () => { if (it.disabled) return; close(); onPick(it.value, it); }, onmousemove: () => { idx = i; $$('.combo-item', list).forEach((e, j) => e.classList.toggle('hl', j === i)); } },
          it.icon ? h('span', { class: 'ci-ico', html: it.icon }) : null,
          h('span', { class: 'ci-txt' }, h('span', { class: 'ci-l', style: it.fontFamily ? { fontFamily: it.fontFamily } : null }, it.label), it.sub ? h('span', { class: 'ci-s' }, it.sub) : null),
          it.badge ? h('span', { class: 'ci-b' }, it.badge) : null,
          it.value === value ? h('span', { class: 'ci-check', html: icon('check') }) : null);
        list.append(row);
      });
      if (!shown.length) list.append(h('div', { class: 'combo-empty' }, 'No matches'));
    };
    if (title) pop.append(h('div', { class: 'combo-title' }, title));
    let inp = null;
    if (search || items.length > 9) {
      inp = h('input', { class: 'combo-search', placeholder: 'Search…', spellcheck: 'false' });
      inp.addEventListener('input', () => { q = inp.value.toLowerCase(); shown = items.filter((i) => (i.label + ' ' + (i.sub || '') + ' ' + (i.group || '')).toLowerCase().includes(q)); idx = 0; draw(); });
      pop.append(inp);
    }
    pop.append(list); if (footer) pop.append(footer);
    document.body.append(pop); draw();
    const r = anchor.getBoundingClientRect(); const pr = pop.getBoundingClientRect();
    let left = align === 'right' ? r.right - pr.width : r.left; left = Math.max(8, Math.min(left, innerWidth - pr.width - 8));
    let top = r.bottom + 6; if (top + pr.height > innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    const sel = $('.combo-item.sel', list); if (sel) sel.scrollIntoView({ block: 'center' });
    const close = () => { pop.remove(); removeEventListener('mousedown', off, true); removeEventListener('keydown', key, true); anchor.classList.remove('open'); if (Combo._cur && Combo._cur.pop === pop) Combo._cur = null; };
    Combo._cur = { anchor, pop, close };
    const off = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, shown.length - 1); draw(); $('.combo-item.hl', list)?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); draw(); $('.combo-item.hl', list)?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter' && shown[idx] && !shown[idx].disabled) { e.preventDefault(); const it = shown[idx]; close(); onPick(it.value, it); }
    };
    setTimeout(() => { addEventListener('mousedown', off, true); addEventListener('keydown', key, true); }, 0);
    anchor.classList.add('open'); if (inp) setTimeout(() => inp.focus(), 20);
    return { close };
  },
  // free-form popover panel anchored to a button
  panel(anchor, content, opts = {}) {
    if (Combo._cur && Combo._cur.anchor === anchor && document.body.contains(Combo._cur.pop)) { Combo._cur.close(); return { close() {} }; }
    Combo.closeAll();
    const pop = h('div', { class: 'combo-pop ' + (opts.cls || ''), style: { width: (opts.width || 320) + 'px' } }, content);
    document.body.append(pop);
    const r = anchor.getBoundingClientRect(); const pr = pop.getBoundingClientRect();
    let left = opts.align === 'right' ? r.right - pr.width : r.left; left = Math.max(8, Math.min(left, innerWidth - pr.width - 8));
    pop.style.left = left + 'px'; pop.style.top = (r.bottom + 6) + 'px';
    const close = () => { pop.remove(); removeEventListener('mousedown', off, true); removeEventListener('keydown', key, true); if (Combo._cur && Combo._cur.pop === pop) Combo._cur = null; };
    Combo._cur = { anchor, pop, close };
    const off = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    setTimeout(() => { addEventListener('mousedown', off, true); addEventListener('keydown', key, true); }, 0);
    return { close };
  },
  // a button that shows current selection and opens a combo
  button(opts) {
    const { icon: ic, label, caret = true, title, cls = '' } = opts;
    return h('button', { class: 'cbtn ' + cls, title: title || '' }, ic ? h('span', { class: 'cb-ico', html: ic }) : null, h('span', { class: 'cb-l' }, label), caret ? h('span', { class: 'cb-car', html: icon('chevDown') }) : null);
  },
};
