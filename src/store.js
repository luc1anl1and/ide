// Main-process helpers: encrypted API keys + env injection, live Claude model list, cross-agent chat history
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, ipcMain, safeStorage } = require('electron');

const keysFile = () => path.join(app.getPath('userData'), 'keys.json');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// Each entry: which env vars to export, which agents can consume it, and the default consumers
const CATALOG = [
  { id: 'anthropic', label: 'Anthropic', env: ['ANTHROPIC_API_KEY'], agents: ['claude', 'opencode'], defaults: ['opencode'], note: 'Enabling it for Claude switches that agent from your subscription to pay-per-token API billing.' },
  { id: 'openai', label: 'OpenAI', env: ['OPENAI_API_KEY'], agents: ['codex', 'opencode'], defaults: ['opencode'] },
  { id: 'openrouter', label: 'OpenRouter', env: ['OPENROUTER_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'google', label: 'Google Gemini', env: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'groq', label: 'Groq', env: ['GROQ_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'deepseek', label: 'DeepSeek', env: ['DEEPSEEK_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'xai', label: 'xAI (Grok)', env: ['XAI_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'mistral', label: 'Mistral', env: ['MISTRAL_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'together', label: 'Together AI', env: ['TOGETHER_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'fireworks', label: 'Fireworks AI', env: ['FIREWORKS_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'cerebras', label: 'Cerebras', env: ['CEREBRAS_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'perplexity', label: 'Perplexity', env: ['PERPLEXITY_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'huggingface', label: 'Hugging Face', env: ['HF_TOKEN'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'azure', label: 'Azure OpenAI', env: ['AZURE_API_KEY'], agents: ['opencode'], defaults: ['opencode'], note: 'Also set AZURE_RESOURCE_NAME in environment variables.' },
  { id: 'bedrock', label: 'Amazon Bedrock', env: ['AWS_BEARER_TOKEN_BEDROCK'], agents: ['opencode'], defaults: ['opencode'] },
  { id: 'opencodezen', label: 'OpenCode Zen', env: ['OPENCODE_API_KEY'], agents: ['opencode'], defaults: ['opencode'] },
];

function loadKeys() {
  const raw = readJson(keysFile(), {}); const out = {};
  for (const [id, v] of Object.entries(raw)) {
    try { out[id] = v.enc ? safeStorage.decryptString(Buffer.from(v.enc, 'base64')) : v.plain; } catch { }
  }
  return out;
}
function saveKey(id, value) {
  const raw = readJson(keysFile(), {});
  if (value == null || value === '') delete raw[id];
  else raw[id] = safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(value).toString('base64') } : { plain: value };
  fs.mkdirSync(path.dirname(keysFile()), { recursive: true });
  fs.writeFileSync(keysFile(), JSON.stringify(raw));
}

// env passed to an agent process: enabled keys + user-defined variables
function agentEnv(provider) {
  const s = readJson(settingsFile(), {}); const keys = loadKeys(); const env = {};
  for (const c of CATALOG) {
    if (!keys[c.id]) continue;
    const use = (s.keyUse && s.keyUse[c.id]) || c.defaults;
    if (use.includes(provider)) for (const e of c.env) env[e] = keys[c.id];
  }
  for (const ev of s.envVars || []) if (ev && ev.k && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ev.k)) env[ev.k] = String(ev.v ?? '');
  return env;
}

// ---------- Claude models (live from the account + known legacy ids) ----------
const LEGACY = [
  ['claude-opus-4-1-20250805', 'Claude Opus 4.1'], ['claude-opus-4-20250514', 'Claude Opus 4'], ['claude-sonnet-4-20250514', 'Claude Sonnet 4'],
  ['claude-3-7-sonnet-20250219', 'Claude Sonnet 3.7'], ['claude-3-5-sonnet-20241022', 'Claude Sonnet 3.5 (new)'], ['claude-3-5-sonnet-20240620', 'Claude Sonnet 3.5'],
  ['claude-3-5-haiku-20241022', 'Claude Haiku 3.5'], ['claude-3-opus-20240229', 'Claude Opus 3'], ['claude-3-sonnet-20240229', 'Claude Sonnet 3'], ['claude-3-haiku-20240307', 'Claude Haiku 3'],
];
let modelCache = null;
async function claudeModels() {
  if (modelCache && Date.now() - modelCache.at < 600000) return modelCache.v;
  let live = [], error = null;
  try {
    const tok = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth;
    const res = await fetch('https://api.anthropic.com/v1/models?limit=200', { headers: { Authorization: 'Bearer ' + tok.accessToken, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000) });
    if (res.ok) live = (await res.json()).data.map((m) => ({ id: m.id, name: m.display_name, created: Date.parse(m.created_at) || 0, live: true }));
    else error = 'HTTP ' + res.status;
  } catch (e) { error = e.message; }
  const have = new Set(live.map((m) => m.id));
  const legacy = LEGACY.filter(([id]) => !have.has(id)).map(([id, name]) => ({ id, name, created: 0, legacy: true }));
  const v = { models: [...live.sort((a, b) => b.created - a.created), ...legacy], error };
  if (live.length) modelCache = { at: Date.now(), v };
  return v;
}

// ---------- Claude history on disk (all projects, including chats started in a plain terminal) ----------
const claudeRoot = () => path.join(os.homedir(), '.claude', 'projects');
const textOf = (msg) => { const c = msg && msg.content; if (typeof c === 'string') return c; if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join(' '); return ''; };
async function claudeSessions(limit = 250) {
  const out = []; let dirs = [];
  try { dirs = await fs.promises.readdir(claudeRoot()); } catch { return []; }
  const files = [];
  for (const d of dirs) {
    let list = []; try { list = await fs.promises.readdir(path.join(claudeRoot(), d)); } catch { continue; }
    for (const f of list) if (f.endsWith('.jsonl')) { try { const full = path.join(claudeRoot(), d, f); const st = await fs.promises.stat(full); files.push({ full, id: f.slice(0, -6), mtime: st.mtimeMs, size: st.size }); } catch { } }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, limit * 2)) {
    if (out.length >= limit) break;
    try {
      const fd = await fs.promises.open(f.full, 'r'); const b = Buffer.alloc(Math.min(f.size, 128 * 1024)); await fd.read(b, 0, b.length, 0); await fd.close();
      let title = '', cwd = '', summary = '', model = '';
      for (const l of b.toString('utf8').split('\n')) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        if (!cwd && j.cwd) cwd = j.cwd;
        if (!model && j.type === 'assistant' && j.message && j.message.model && !/synthetic/.test(j.message.model)) model = j.message.model;
        if (j.type === 'summary' && j.summary && !summary) summary = j.summary;
        if (!title && j.type === 'user' && !j.isMeta && !j.isSidechain) { const t = textOf(j.message).trim(); if (t && !t.startsWith('<')) title = t; }
      }
      if (!title && !summary) continue;
      out.push({ id: f.id, provider: 'claude', title: (summary || title).replace(/\s+/g, ' ').slice(0, 140), cwd, model, updatedAt: f.mtime });
    } catch { }
  }
  return out;
}
async function findClaudeFile(id) {
  let dirs = []; try { dirs = await fs.promises.readdir(claudeRoot()); } catch { return null; }
  for (const d of dirs) { const p = path.join(claudeRoot(), d, id + '.jsonl'); if (fs.existsSync(p)) return p; }
  return null;
}
async function readClaude(id) {
  const f = await findClaudeFile(id); if (!f) return [];
  const evs = [];
  for (const l of (await fs.promises.readFile(f, 'utf8')).split('\n')) { if (!l.trim()) continue; try { const j = JSON.parse(l); if (j.type === 'user' || j.type === 'assistant') evs.push(j); } catch { } }
  return evs.slice(-400);
}

// ---------- Claude undo: truncate the session file before the Nth user turn (backup kept) and best-effort revert file edits ----------
function isUserTurn(j) {
  if (!j || j.type !== 'user' || j.isMeta || j.isSidechain) return false;
  const c = j.message && j.message.content;
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return false;
  const t = textOf(j.message).trim();
  return (t && !t.startsWith('<')) || (Array.isArray(c) && c.some((b) => b.type === 'image'));
}
async function claudeRewind(id, keep) {
  const f = await findClaudeFile(id); if (!f) return { ok: false, error: 'Session file not found' };
  const raw = (await fs.promises.readFile(f, 'utf8')).split('\n');
  const parsed = raw.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  let count = -1, cut = -1, total = parsed.filter(isUserTurn).length;
  for (let i = 0; i < parsed.length; i++) if (isUserTurn(parsed[i])) { count++; if (count === keep) { cut = i; break; } }
  if (cut < 0) return { ok: false, error: 'Nothing to undo' };
  const removed = parsed.slice(cut).filter(Boolean);
  const results = {};
  for (const j of removed) if (j.type === 'user' && Array.isArray(j.message && j.message.content)) for (const b of j.message.content) if (b.type === 'tool_result') results[b.tool_use_id] = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('');
  const ops = [];
  for (const j of removed) if (j.type === 'assistant') for (const b of (j.message && j.message.content) || []) if (b.type === 'tool_use') ops.push(b);
  try { const dir = path.join(app.getPath('userData'), 'backups'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${id}-${Date.now()}.jsonl`), raw.join('\n')); } catch { }
  await fs.promises.writeFile(f, raw.slice(0, cut).join('\n') + '\n');
  let reverted = 0, skipped = 0;
  for (const op of ops.reverse()) {
    const inp = op.input || {}; const fp = inp.file_path; if (!fp || !path.isAbsolute(fp)) { if (op.name === 'Bash') skipped++; continue; }
    try {
      if (op.name === 'Edit' || op.name === 'MultiEdit') {
        const edits = op.name === 'Edit' ? [inp] : (inp.edits || []).slice().reverse();
        let s = fs.readFileSync(fp, 'utf8'); let ok = true;
        for (const e of edits) { const i = e.new_string ? s.lastIndexOf(e.new_string) : -1; if (i < 0) { ok = false; break; } s = s.slice(0, i) + (e.old_string || '') + s.slice(i + e.new_string.length); }
        if (ok) { fs.writeFileSync(fp, s); reverted++; } else skipped++;
      } else if (op.name === 'Write') {
        if (/created/i.test(results[op.id] || '') && fs.existsSync(fp)) { fs.unlinkSync(fp); reverted++; } else skipped++;
      }
    } catch { skipped++; }
  }
  return { ok: true, removedTurns: total - keep, filesReverted: reverted, filesSkipped: skipped };
}

// ---------- Reva's own chat store (userData/chats): transcripts survive even if the CLI deletes its history ----------
const chatsDir = () => { const d = path.join(app.getPath('userData'), 'chats'); fs.mkdirSync(d, { recursive: true }); return d; };
const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '');
function listRevaChats() {
  const d = chatsDir(); const out = [];
  for (const f of fs.readdirSync(d)) { if (!f.endsWith('.meta.json')) continue; try { out.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch { } }
  return out;
}

function register({ lazy }) {
  ipcMain.handle('chats:save', (_e, { id, meta, events }) => {
    try {
      id = safeId(id); const d = chatsDir();
      fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify(events));
      fs.writeFileSync(path.join(d, id + '.meta.json'), JSON.stringify({ ...meta, id, updatedAt: Date.now(), source: 'reva' }));
      return true;
    } catch { return false; }
  });
  ipcMain.handle('chats:read', (_e, id) => { try { return JSON.parse(fs.readFileSync(path.join(chatsDir(), safeId(id) + '.json'), 'utf8')); } catch { return []; } });
  ipcMain.handle('chats:delete', (_e, id) => { try { id = safeId(id); for (const f of [id + '.json', id + '.meta.json']) fs.rmSync(path.join(chatsDir(), f), { force: true }); return true; } catch { return false; } });
  ipcMain.handle('chats:dir', () => chatsDir());
  const codexMod = lazy('./agents/codex'), opencodeMod = lazy('./agents/opencode');
  ipcMain.handle('keys:catalog', () => CATALOG);
  ipcMain.handle('keys:list', () => { const k = loadKeys(); const o = {}; for (const [id, v] of Object.entries(k)) o[id] = '••••' + String(v).slice(-4); return o; });
  ipcMain.handle('keys:set', (_e, { id, value }) => { saveKey(id, value); return true; });
  ipcMain.handle('claude:models', () => claudeModels());
  ipcMain.handle('sessions:all', async (_e, { custom }) => {
    const env = { codex: agentEnv('codex'), opencode: agentEnv('opencode') };
    const t = (p) => p.catch(() => []);
    const [c, x, o] = await Promise.all([
      t(claudeSessions()),
      t((async () => { const m = codexMod(); return m.listSessions ? m.listSessions(custom && custom.codex, { env: env.codex }) : []; })()),
      t((async () => { const m = opencodeMod(); return m.listSessions ? m.listSessions(custom && custom.opencode, { env: env.opencode }) : []; })()),
    ]);
    const reva = (() => { try { return listRevaChats(); } catch { return []; } })();
    const mine = new Set(reva.map((r) => r.sessionId).filter(Boolean)); // a CLI session already stored by Reva is shown once, as a Reva chat
    const native = [...c, ...(x || []), ...(o || [])].filter((s) => !mine.has(s.id)).map((s) => ({ ...s, source: 'cli' }));
    return [...reva, ...native].sort((a, b) => b.updatedAt - a.updatedAt);
  });
  ipcMain.handle('sessions:read', async (_e, { provider, id, custom }) => {
    try {
      if (provider === 'claude') return await readClaude(id);
      if (provider === 'codex') return (await codexMod().readSession(custom, id, { env: agentEnv('codex') })) || [];
      return (await opencodeMod().readSession(custom, id, { env: agentEnv('opencode') })) || [];
    } catch { return []; }
  });
}

module.exports = { register, agentEnv, CATALOG, claudeRewind, loadKeys, readSettings: () => readJson(settingsFile(), {}) };
