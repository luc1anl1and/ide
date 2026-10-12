// Keyboard shortcuts: a registry of commands with default key combos the user can rebind (Settings → Shortcuts).
(function () {
  const CODE = { Backquote: '`', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Space: 'Space' };
  const NAMED = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
  const defs = []; // {id, label, group, def, run}
  const keyOf = (e) => {
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
    if (/^F\d{1,2}$/.test(e.code)) return e.code;
    if (CODE[e.code]) return CODE[e.code];
    if (NAMED[e.key]) return NAMED[e.key];
    return e.key && e.key.length === 1 ? e.key.toUpperCase() : null;
  };
  // event -> "Ctrl+Shift+P" (null for a lone modifier)
  const fmt = (e) => {
    const k = keyOf(e); if (!k || /^(Control|Shift|Alt|Meta)$/.test(e.key)) return null;
    return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', k].filter(Boolean).join('+');
  };
  const Keys = {
    defs,
    register(list) { list.forEach((d) => defs.push(d)); },
    get(id) { const d = defs.find((x) => x.id === id); if (!d) return ''; const o = (A.settings.keys || {})[id]; return o === undefined ? d.def : o; },
    set(id, combo) {
      const k = (A.settings.keys = A.settings.keys || {}); let stolen = null;
      if (combo) defs.forEach((d) => { if (d.id !== id && Keys.get(d.id) === combo) { k[d.id] = ''; stolen = d; } });
      const d = defs.find((x) => x.id === id); k[id] = combo === d.def ? undefined : combo; if (k[id] === undefined) delete k[id];
      // a default that another command moved away from is still "owned" by the new binding, so store explicit '' for the command that lost it
      saveSettings(); return stolen;
    },
    reset(id) { if (A.settings.keys) delete A.settings.keys[id]; saveSettings(); },
    resetAll() { A.settings.keys = {}; saveSettings(); },
    handle(e) {
      const c = fmt(e); if (!c) return false;
      const d = defs.find((x) => Keys.get(x.id) === c && x.run); if (!d) return false;
      if (d.when && !d.when(e)) return false;
      e.preventDefault(); d.run(e); return true;
    },
    fmt,
    // "Press the new shortcut…" capture; resolves with combo, '' (cleared) or null (cancelled)
    capture() {
      return new Promise((res) => {
        const on = (e) => {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') { done(null); return; }
          if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.shiftKey) { done(''); return; }
          const c = fmt(e); if (c) done(c);
        };
        const done = (v) => { removeEventListener('keydown', on, true); res(v); };
        addEventListener('keydown', on, true);
      });
    },
  };
  window.Keys = Keys;
})();