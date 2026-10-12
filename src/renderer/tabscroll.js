// Horizontal tab strips: soft edge shadows, scroll arrows and (optionally) a button listing every tab.
// TabScroll(scrollerEl, { list: () => [{label, sub, icon, value, on}], onPick(value) }) -> wrapper element to put in the page.
window.TabScroll = function (scroller, o = {}) {
  const step = () => Math.max(140, scroller.clientWidth * 0.6);
  const mk = (cls, ic, title, dir) => h('button', { class: 'tsa ' + cls, type: 'button', title, html: icon(ic), tabindex: '-1', onmousedown: (e) => e.preventDefault(), onclick: () => scroller.scrollBy({ left: dir * step(), behavior: 'smooth' }) });
  const L = mk('l', 'chevLeft', 'Scroll left', -1), R = mk('r', 'chev', 'Scroll right', 1);
  const wrap = h('div', { class: 'tsw' }, scroller, L, R);
  const upd = () => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    wrap.classList.toggle('ov-l', scroller.scrollLeft > 2); wrap.classList.toggle('ov-r', scroller.scrollLeft < max - 2); wrap.classList.toggle('ov', max > 2);
  };
  scroller.addEventListener('scroll', upd, { passive: true });
  scroller.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { scroller.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  if (window.ResizeObserver) { const ro = new ResizeObserver(upd); ro.observe(scroller); }
  new MutationObserver(upd).observe(scroller, { childList: true, subtree: true, characterData: true });
  wrap.update = upd; setTimeout(upd, 0);
  wrap.reveal = (el) => { if (!el) return; const a = el.offsetLeft - 36, b = el.offsetLeft + el.offsetWidth + 36; if (a < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, a); else if (b > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = b - scroller.clientWidth; upd(); };
  // the "all tabs" list button
  wrap.listButton = (title) => h('button', { class: 'icon-btn', title: title || 'All tabs', html: icon('list'), onclick: (e) => {
    const items = o.list ? o.list() : []; if (!items.length) return;
    Combo.open(e.currentTarget, { title: title || 'Open tabs', width: 320, align: 'right', value: (items.find((x) => x.on) || {}).value, items, search: items.length > 12, onPick: (v) => o.onPick && o.onPick(v) });
  } });
  return wrap;
};