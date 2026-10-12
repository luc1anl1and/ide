// Theme definitions: UI variables + Monaco token colors
window.THEMES = {
  amethyst: {
    name: 'Amethyst', dark: true,
    v: { bg: '#0e0b14', bg1: '#15111d', bg2: '#1d1828', bg3: '#272034', border: '#2a2338', fg: '#e8e4f1', fg2: '#a6a0b8', fg3: '#6d6781', accent: '#a78bfa', accent2: '#c4b0ff' },
    t: { keyword: 'c792ff', string: 'b6f09c', number: 'ffb86b', comment: '6e5f93', type: '7ee0ff', func: 'ffd479', variable: 'efe9ff', operator: 'ff8ad8' },
  },
  midnight: {
    name: 'Midnight Violet', dark: true,
    v: { bg: '#0b0814', bg1: '#100c1c', bg2: '#17122a', bg3: '#211a3b', border: '#241c3f', fg: '#e4defa', fg2: '#a99cd0', fg3: '#6e6396', accent: '#8b5cf6', accent2: '#b794ff' },
    t: { keyword: 'a78bfa', string: '86efac', number: 'fdba74', comment: '5f5585', type: '67e8f9', func: 'fde68a', variable: 'e9e5ff', operator: 'f0abfc' },
  },
  obsidian: {
    name: 'Obsidian', dark: true,
    v: { bg: '#09090d', bg1: '#0e0e14', bg2: '#15151e', bg3: '#1e1e2b', border: '#222232', fg: '#e6e4ee', fg2: '#a8a5ba', fg3: '#6b6880', accent: '#9d6bff', accent2: '#c4a3ff' },
    t: { keyword: 'b490ff', string: 'a3e4a0', number: 'f5b369', comment: '5b5870', type: '7cd4ee', func: 'f1d27a', variable: 'ebe9f5', operator: 'e69be0' },
  },
  neon: {
    name: 'Neon Synthwave', dark: true,
    v: { bg: '#170a29', bg1: '#1e0d36', bg2: '#2a1248', bg3: '#381a5f', border: '#42206d', fg: '#f3e8ff', fg2: '#c4a6ee', fg3: '#8a6bb8', accent: '#ff4fd8', accent2: '#00e5ff' },
    t: { keyword: 'ff6ad5', string: '72f1b8', number: 'ff9e64', comment: '7a5aa6', type: '36f9f6', func: 'fede5d', variable: 'f3e8ff', operator: 'ff7edb' },
  },
  dracula: {
    name: 'Dracula', dark: true,
    v: { bg: '#21222c', bg1: '#282a36', bg2: '#303243', bg3: '#3a3d52', border: '#44475a', fg: '#f8f8f2', fg2: '#c0c3d9', fg3: '#7c80a3', accent: '#bd93f9', accent2: '#ff79c6' },
    t: { keyword: 'ff79c6', string: 'f1fa8c', number: 'bd93f9', comment: '6272a4', type: '8be9fd', func: '50fa7b', variable: 'f8f8f2', operator: 'ff79c6' },
  },
  rosepine: {
    name: 'Rosé Pine', dark: true,
    v: { bg: '#161421', bg1: '#191724', bg2: '#201e30', bg3: '#2a2740', border: '#312e4a', fg: '#e0def4', fg2: '#a8a3c7', fg3: '#6e6a86', accent: '#c4a7e7', accent2: '#ebbcba' },
    t: { keyword: '31748f', string: 'f6c177', number: 'ebbcba', comment: '6e6a86', type: '9ccfd8', func: 'ebbcba', variable: 'e0def4', operator: '908caa' },
  },
  nebula: {
    name: 'Nebula', dark: true,
    v: { bg: '#0d0e1f', bg1: '#121428', bg2: '#1a1d3a', bg3: '#242850', border: '#2a2e58', fg: '#e3e6ff', fg2: '#a5abdd', fg3: '#6a70a6', accent: '#7c7cff', accent2: '#c77dff' },
    t: { keyword: '9d8cff', string: '9be8c0', number: 'ffb27a', comment: '5c628f', type: '6fd8ff', func: 'ffd98a', variable: 'e8eaff', operator: 'd69bff' },
  },
  orchid: {
    name: 'Orchid Light', dark: false,
    v: { bg: '#faf7ff', bg1: '#f2ecfc', bg2: '#e9e0f9', bg3: '#ddd0f3', border: '#d5c7ee', fg: '#2a1f45', fg2: '#5b4a85', fg3: '#8f7fb5', accent: '#7c3aed', accent2: '#c026d3' },
    t: { keyword: '7c3aed', string: '15803d', number: 'c2410c', comment: '9a8bbf', type: '0e7490', func: 'a16207', variable: '2a1f45', operator: 'be185d' },
  },
};

window.applyTheme = function (id, accentOverride) {
  const th = window.THEMES[id] || window.THEMES.amethyst;
  const r = document.documentElement;
  const v = { ...th.v };
  if (accentOverride) v.accent = accentOverride;
  for (const k in v) r.style.setProperty('--' + k, v[k]);
  r.dataset.theme = th.dark ? 'dark' : 'light';
  r.style.colorScheme = th.dark ? 'dark' : 'light';
  return th;
};

window.defineMonacoThemes = function (monaco, accentOverride) {
  for (const [id, th] of Object.entries(window.THEMES)) {
    const v = { ...th.v }; if (accentOverride) v.accent = accentOverride;
    const t = th.t;
    monaco.editor.defineTheme('am-' + id, {
      base: th.dark ? 'vs-dark' : 'vs', inherit: true,
      rules: [
        { token: '', foreground: t.variable },
        { token: 'comment', foreground: t.comment, fontStyle: 'italic' },
        { token: 'keyword', foreground: t.keyword }, { token: 'keyword.control', foreground: t.keyword },
        { token: 'string', foreground: t.string }, { token: 'string.escape', foreground: t.operator },
        { token: 'number', foreground: t.number }, { token: 'regexp', foreground: t.operator },
        { token: 'type', foreground: t.type }, { token: 'type.identifier', foreground: t.type }, { token: 'class', foreground: t.type },
        { token: 'identifier', foreground: t.variable }, { token: 'variable', foreground: t.variable },
        { token: 'function', foreground: t.func }, { token: 'delimiter', foreground: t.operator }, { token: 'operator', foreground: t.operator },
        { token: 'tag', foreground: t.keyword }, { token: 'attribute.name', foreground: t.func }, { token: 'attribute.value', foreground: t.string },
        { token: 'key', foreground: t.type }, { token: 'string.key.json', foreground: t.type }, { token: 'string.value.json', foreground: t.string },
      ],
      colors: {
        'editor.background': v.bg, 'editor.foreground': v.fg,
        'editorLineNumber.foreground': v.fg3, 'editorLineNumber.activeForeground': v.accent2,
        'editor.lineHighlightBackground': v.bg1, 'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': v.accent + '44', 'editor.inactiveSelectionBackground': v.accent + '22',
        'editor.selectionHighlightBackground': v.accent + '22', 'editor.wordHighlightBackground': v.accent + '22',
        'editorCursor.foreground': v.accent2, 'editorIndentGuide.background1': v.fg3 + '3a', 'editorIndentGuide.activeBackground1': v.fg3 + '99', 'editorBracketPairGuide.background1': v.accent + '33', 'editorBracketPairGuide.activeBackground1': v.accent + '88', 'editorStickyScroll.background': v.bg1, 'editorOverviewRuler.border': '#00000000', 'editorWhitespace.foreground': v.fg3 + '44',
        'editorWidget.background': v.bg2, 'editorWidget.border': v.border, 'editorSuggestWidget.background': v.bg2,
        'editorSuggestWidget.selectedBackground': v.bg3, 'editorHoverWidget.background': v.bg2, 'editorHoverWidget.border': v.border,
        'input.background': v.bg1, 'input.border': v.border, 'focusBorder': v.accent,
        'scrollbarSlider.background': v.accent + '22', 'scrollbarSlider.hoverBackground': v.accent + '44', 'scrollbarSlider.activeBackground': v.accent + '66',
        'minimap.background': v.bg, 'editorGutter.background': v.bg, 'editorBracketMatch.background': v.accent + '33', 'editorBracketMatch.border': v.accent,
        'menu.background': v.bg2, 'menu.foreground': v.fg, 'menu.selectionBackground': v.bg3, 'menu.separatorBackground': v.border,
      },
    });
  }
};
