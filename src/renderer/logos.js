// Brand marks (provider + vendor logos), effort / mode glyphs
(function () {
  const svg = (inner, vb = '0 0 24 24', extra = '') => `<svg viewBox="${vb}" ${extra}>${inner}</svg>`;

  // Claude: the real symbol (user's asset, embedded raster so it scales and can be animated)
  const claude = svg(`<image href="${window.CLAUDE_MARK || ''}" width="24" height="24"/>`);

  // OpenAI blossom
  const openai = svg('<path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>');

  // OpenCode block mark
  const opencode = svg('<path fill-rule="evenodd" fill="#B7B1B1" d="M18 6H6v18h12V6zM24 30H0V0h24v30z"/><path fill="#6b6565" d="M18 24H6V12h12v12z"/>', '0 0 24 30');

  // generic mark for unknown vendors: monogram
  const mono = (t) => svg(`<rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" opacity=".18"/><text x="12" y="16.3" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" font-family="Inter,Segoe UI,sans-serif">${t}</text>`);

  const google = svg('<path fill="currentColor" d="M12 2c.4 5.6 4.4 9.6 10 10-5.6.4-9.6 4.4-10 10-.4-5.6-4.4-9.6-10-10 5.6-.4 9.6-4.4 10-10z"/>');
  const meta = svg('<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M3 15c0-4 2-8 4.4-8 3 0 5.200 10 9.200 10 2.200 0 4.400-3 4.400-6.500 0-3-1.200-5.500-3-5.500-2.800 0-5.200 10-9.200 10"/>');
  const mistral = svg('<g fill="currentColor"><rect x="2" y="3" width="4" height="4"/><rect x="18" y="3" width="4" height="4"/><rect x="6" y="7" width="4" height="4"/><rect x="14" y="7" width="4" height="4"/><rect x="10" y="11" width="4" height="4"/><rect x="2" y="15" width="4" height="4"/><rect x="18" y="15" width="4" height="4"/><rect x="2" y="11" width="4" height="4"/><rect x="18" y="11" width="4" height="4"/></g>');
  const deepseek = svg('<path fill="currentColor" d="M21 7.500c-.700-.300-1.400.300-2.200.100-.800-1.200-2-1.700-3.300-1.500C13.600 3.800 10.800 3.600 8.800 5 5.700 5.200 3 7.800 3 11c0 4 3 7 7.500 7 2.300 0 4.400-1 5.700-2.800 2.500-.500 4.800-2.600 4.800-5.200 0-.800-.100-1.800-1-2.500zm-12 3a.9.9 0 1 1 0-1.800.9.9 0 0 1 0 1.800z"/>');
  const xai = svg('<path fill="currentColor" d="M3 4h3.500l5.300 7.600L17.500 4H21l-7.500 9.500L21 20h-3.500l-5.800-8.200L5.900 20H3l7.500-9.400z"/>');
  const qwen = mono('Q'), zhipu = mono('Z'), moonshot = mono('K'), nvidia = mono('N'), bigp = mono('B');

  // custom agents have no brand mark: a neutral outline glyph in the current text color
  window.monoLogo = () => icon('agent');
  window.LOGO = { claude, codex: openai, openai, opencode, google, gemini: google, meta, llama: meta, mistral, deepseek, xai, grok: xai, qwen, zhipu, glm: zhipu, moonshot, kimi: moonshot, nvidia, anthropic: claude, 'opencode-zen': opencode };
  // best logo for a vendor/model id string
  window.logoFor = function (s) {
    s = String(s || '').toLowerCase();
    const hit = [['claude', 'claude'], ['anthropic', 'claude'], ['fable', 'claude'], ['opus', 'claude'], ['sonnet', 'claude'], ['haiku', 'claude'], ['gpt', 'openai'], ['openai', 'openai'], ['codex', 'openai'], ['o3', 'openai'], ['o4', 'openai'], ['gemini', 'google'], ['google', 'google'], ['llama', 'meta'], ['meta', 'meta'], ['mistral', 'mistral'], ['deepseek', 'deepseek'], ['grok', 'xai'], ['xai', 'xai'], ['qwen', 'qwen'], ['glm', 'zhipu'], ['zhipu', 'zhipu'], ['kimi', 'moonshot'], ['moonshot', 'moonshot'], ['nemotron', 'nvidia'], ['nvidia', 'nvidia'], ['opencode', 'opencode']].find(([k]) => s.includes(k));
    return hit ? LOGO[hit[1]] : mono((s.replace(/[^a-z]/g, '')[0] || '?').toUpperCase());
  };

  // effort glyph: n/5 signal bars (+ bolt for the top tiers)
  const ORDER = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  window.effortIcon = function (id) {
    const lv = { '': 3, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 5 }[id] ?? 3;
    const bars = [0, 1, 2, 3, 4].map((i) => `<rect x="${2.5 + i * 4.3}" y="${21 - (i + 1) * 3.8}" width="3.1" height="${(i + 1) * 3.8}" rx="1.3" fill="currentColor" opacity="${i < lv ? 1 : .25}"/>`).join('');
    return svg(bars) + '';
  };
  // mode glyphs
  const stroke = (p) => svg(p, '0 0 24 24', 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"');
  window.MODE_ICON = {
    manual: stroke('<path d="M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
    ask: stroke('<path d="M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
    acceptEdits: stroke('<path d="M12 20h9"/><path d="M16.500 3.500a2.100 2.100 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    plan: stroke('<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M14 3l7 7M9 15l1-4 8-8 3 3-8 8z"/>'),
    auto: stroke('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
    dontAsk: stroke('<circle cx="12" cy="12" r="9"/><path d="M5.600 5.600l12.800 12.800"/>'),
    bypassPermissions: stroke('<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>'),
    readonly: stroke('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>'),
    full: stroke('<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>'),
  };
  window.ORDER_EFFORT = ORDER;
})();
