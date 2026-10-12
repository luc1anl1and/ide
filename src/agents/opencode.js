// OpenCode adapter: makes `opencode run --format json` look like a Claude-Code stream-json session so the
// Reva chat renderer (renderer/chat.js) can display it unchanged.
//
//   start(opts, hooks) -> { write(obj), kill(), rewind(keepTurns) }
//   rewindSession(custom, sessionId, keepTurns, {env, cwd}) -> Promise<{ok, error?, filesReverted?, filesSkipped?, note?}>
//   service(custom)    -> Promise<{installed, cmd, version, models, providers, stats, usage}>
//   resolveOpencode(custom) -> { cmd, shell, shim? } | null
//   login(custom)      -> Promise<{ok}>   (opens a visible console running `opencode auth login`)
//
// OpenCode's `run` is one process per user turn, so a "session" here is a bag of config plus the
// OpenCode session id (ses_...) learned from the first event; later turns pass `--session <id>`.
// The user message is fed through stdin (no shell quoting problems, no command-line length limit).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const inst = require('./installer');

const IMG_DIR = path.join(os.tmpdir(), 'reva-img');
const SERVICE_TIMEOUT = 20000;

// ------------------------------------------------------------------ binary resolution
// custom: path string or { opencode: path }. Returns { cmd, shell } (shell=true only for an
// un-unwrappable .cmd shim) or null when OpenCode is not installed.
function resolveOpencode(custom) {
  let file = typeof custom === 'string' ? custom : custom && custom.opencode;
  if (!file || !fs.existsSync(file)) {
    file = inst.findOnPath('opencode', ['.exe', '.cmd', '.bat']);
    if (!file) { const p = path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd'); if (fs.existsSync(p)) file = p; }
  }
  return file ? inst.targetFor(file) : null;
}

// ------------------------------------------------------------------ tool mapping (OpenCode -> Claude names)
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
const drop = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

// Returns { name, input } in Claude-tool shape. Unknown tools keep their OpenCode name and input.
function mapTool(tool, i, cwd, title) {
  i = i || {};
  const abs = (p) => (p ? (path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p)) : p);
  switch (String(tool).toLowerCase()) {
    case 'shell': case 'bash':
      return { name: 'Bash', input: drop({ command: i.command, description: i.description || title || undefined, timeout: num(i.timeout) }) };
    case 'read':
      return { name: 'Read', input: drop({ file_path: abs(i.path || i.filePath), offset: num(i.offset), limit: num(i.limit) }) };
    case 'write':
      return { name: 'Write', input: { file_path: abs(i.path || i.filePath), content: i.content } };
    case 'edit':
      return { name: 'Edit', input: drop({ file_path: abs(i.path || i.filePath), old_string: i.oldString ?? i.old_string, new_string: i.newString ?? i.new_string, replace_all: i.replaceAll || undefined }) };
    case 'glob':
      return { name: 'Glob', input: drop({ pattern: i.pattern, path: i.path }) };
    case 'grep':
      return { name: 'Grep', input: drop({ pattern: i.pattern, path: i.path, glob: i.include || i.glob }) };
    case 'webfetch':
      return { name: 'WebFetch', input: drop({ url: i.url, format: i.format }) };
    case 'websearch':
      return { name: 'WebSearch', input: drop({ query: i.query }) };
    case 'todowrite': case 'todo':
      return { name: 'TodoWrite', input: { todos: (i.todos || []).map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm || t.content })) } };
    case 'subagent': case 'task':
      return { name: 'Task', input: drop({ description: i.description, prompt: i.prompt, subagent_type: i.subagent_type || i.agent || i.type }) };
    default:
      return { name: tool, input: i };
  }
}

// Keep only string->string pairs from a caller-supplied env object.
function cleanEnv(extra) {
  const o = {};
  if (extra && typeof extra === 'object') for (const [k, v] of Object.entries(extra)) if (k && typeof v === 'string') o[k] = v;
  return o;
}

// ------------------------------------------------------------------ session
const AUTO_MODES = new Set(['auto', 'bypassPermissions', 'dontAsk', 'acceptEdits']);
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

function start(opts = {}, hooks = {}) {
  const emit = (ev) => { try { hooks.emit && hooks.emit(ev); } catch { /* never let the UI break us */ } };
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const model = opts.model || '';
  const target = resolveOpencode(opts.custom);

  const S = {
    sessionId: opts.resume || null,
    child: null,        // running `opencode run`
    queue: [],          // user messages waiting for the current turn to finish
    killed: false,
    tmp: new Set(),     // temp image files of the running turn
    totals: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
  };

  const sendInit = () => emit({ type: 'system', subtype: 'init', session_id: S.sessionId, model, slash_commands: [], mcp_servers: [], tools: [], cwd });
  sendInit();

  function cleanupTmp() {
    for (const f of S.tmp) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    S.tmp.clear();
  }

  // Turn arguments (message goes to stdin)
  function buildArgs(files) {
    const a = ['run', '--format', 'json', '--thinking'];
    // --standalone = private server per turn: killing the process tree really aborts the model/tool run
    // (with the shared background service an interrupted turn keeps running server-side and blocks the
    // next turn of that session). Costs ~1s startup. Pass opts.standalone === false to opt out.
    if (opts.standalone !== false) a.push('--standalone');
    if (model) a.push('-m', model + (opts.effort ? '#' + opts.effort : ''));
    if (S.sessionId) a.push('--session', S.sessionId);
    if (AUTO_MODES.has(opts.mode)) a.push('--auto');
    for (const f of files) a.push('--file', f);
    if (Array.isArray(opts.extraArgs)) a.push(...opts.extraArgs); // user-defined extra flags (Settings → Agents)
    return a;
  }

  function runTurn(msg) {
    // 1) unpack the Claude-style user message
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const files = [];
    try {
      fs.mkdirSync(IMG_DIR, { recursive: true });
      blocks.filter((b) => b.type === 'image' && b.source && b.source.data).forEach((b, n) => {
        const f = path.join(IMG_DIR, `${Date.now().toString(36)}-${n}.${EXT[b.source.media_type] || 'png'}`);
        fs.writeFileSync(f, Buffer.from(b.source.data, 'base64'));
        S.tmp.add(f); files.push(f);
      });
    } catch { /* image attach is best effort */ }

    const startedAt = Date.now();
    let interrupted = false, errMsg = '', stderrTail = '', steps = 0, buf = '';
    const turn = { in: 0, out: 0, reasoning: 0, cr: 0, cw: 0, cost: 0 };

    // 2) event translation state (one open assistant message at a time)
    let cur = null;            // { id, content:[], idx }
    const toolSeen = new Map(); // tool call id -> { done }
    const se = (event) => emit({ type: 'stream_event', event });
    const openMsg = (id) => {
      closeMsg();
      cur = { id: id || 'msg_' + Date.now().toString(36), content: [], idx: 0 };
      se({ type: 'message_start', message: { id: cur.id, role: 'assistant', content: [], model } });
    };
    const ensureMsg = (id) => { if (!cur || (id && id !== cur.id)) openMsg(id); };
    // emit the finalised assistant message (all blocks) for the open message
    const closeMsg = () => {
      if (!cur) return;
      const m = cur; cur = null;
      if (m.content.length) emit({ type: 'assistant', message: { id: m.id, type: 'message', role: 'assistant', model, content: m.content } });
      se({ type: 'message_stop' });
    };
    const textBlock = (kind, value) => {
      const index = cur.idx++;
      const empty = kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' };
      se({ type: 'content_block_start', index, content_block: empty });
      se({ type: 'content_block_delta', index, delta: kind === 'text' ? { type: 'text_delta', text: value } : { type: 'thinking_delta', thinking: value } });
      se({ type: 'content_block_stop', index });
      cur.content.push(kind === 'text' ? { type: 'text', text: value } : { type: 'thinking', thinking: value, signature: '' });
    };

    function handle(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.sessionID && !S.sessionId) { S.sessionId = ev.sessionID; sendInit(); }
      const p = ev.part || {};
      switch (ev.type) {
        case 'step_start': steps++; openMsg(p.messageID); break;
        case 'reasoning': if (p.text && p.text.trim()) { ensureMsg(p.messageID); textBlock('thinking', p.text); } break;
        case 'text': if (p.text) { ensureMsg(p.messageID); textBlock('text', p.text); } break;
        case 'tool_use': {
          const st = p.state || {};
          const id = p.id || p.callID || p.partID;
          let seen = toolSeen.get(id);
          if (!seen) {
            ensureMsg(p.messageID);
            const { name, input } = mapTool(p.tool, st.input, cwd, st.title);
            const index = cur.idx++;
            se({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } });
            se({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
            se({ type: 'content_block_stop', index });
            cur.content.push({ type: 'tool_use', id, name, input });
            seen = { done: false }; toolSeen.set(id, seen);
          }
          if (!seen.done && (st.status === 'completed' || st.status === 'error')) {
            seen.done = true;
            const isErr = st.status === 'error';
            const out = isErr ? (typeof st.error === 'string' ? st.error : JSON.stringify(st.error)) : (typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? ''));
            emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out, is_error: isErr }] } });
          }
          break;
        }
        case 'step_finish': {
          const t = p.tokens || {};
          turn.in += t.input || 0; turn.out += t.output || 0; turn.reasoning += t.reasoning || 0;
          turn.cr += (t.cache && t.cache.read) || 0; turn.cw += (t.cache && t.cache.write) || 0; turn.cost += p.cost || 0;
          closeMsg();
          break;
        }
        case 'error': {
          const e = ev.error || {};
          errMsg = (e.message || e.data?.message || e.name || JSON.stringify(e)).toString();
          break;
        }
        default: break; // unknown event types are ignored
      }
    }

    // 3) spawn
    const args = buildArgs(files);
    let child;
    try {
      const env = inst.freshEnv(cleanEnv(opts.env)); // opts.env (API keys etc.) wins over process.env
      if (!target) throw new Error('OpenCode is not installed (npm install -g opencode-ai)');
      child = target.shell
        ? spawn('"' + target.cmd + '" ' + args.map((a) => (/^[\w@.,:=+#\\/-]+$/.test(a) ? a : '"' + a.replace(/"/g, '""') + '"')).join(' '), [], { cwd, env, shell: true, windowsHide: true })
        : spawn(target.cmd, args, { cwd, env, windowsHide: true });
    } catch (e) {
      cleanupTmp();
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: e.message, duration_ms: 0, total_cost_usd: S.cost, num_turns: 0, session_id: S.sessionId, usage: { ...S.totals } });
      return nextTurn();
    }
    S.child = child;

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch (e) { if (!(e instanceof SyntaxError)) emit({ type: 'stderr', text: 'adapter: ' + e.message }); }
      }
    });
    child.stderr.on('data', (d) => {
      const s = inst.stripAnsi(d.toString('utf8'));
      stderrTail = (stderrTail + s).slice(-2000);
      if (s.trim() && !/^\s*(INFO|DEBUG)\b/.test(s)) emit({ type: 'stderr', text: s });
    });
    child.stdin.on('error', () => { });
    child.stdin.end(text || (files.length ? 'See the attached file(s).' : ''));

    child.on('error', (e) => { errMsg = errMsg || e.message; });
    child.on('close', (code) => {
      S.child = null;
      if (buf.trim()) { try { handle(JSON.parse(buf)); } catch { /* partial */ } }
      closeMsg();
      cleanupTmp();
      if (S.killed) return; // session torn down: stay silent
      // accumulate session totals
      S.totals.input_tokens += turn.in; S.totals.output_tokens += turn.out; S.totals.reasoning_tokens += turn.reasoning;
      S.totals.cache_read += turn.cr; S.totals.cache_write += turn.cw; S.cost += turn.cost;
      const failed = !interrupted && (code !== 0 || !!errMsg);
      emit({ type: 'token_usage', provider: 'opencode', total: { ...S.totals, cost: S.cost }, last: { input_tokens: turn.in, output_tokens: turn.out, reasoning_tokens: turn.reasoning, cache_read: turn.cr, cache_write: turn.cw } });
      const result = {
        type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, session_id: S.sessionId,
        duration_ms: Date.now() - startedAt, total_cost_usd: S.cost, num_turns: steps,
        usage: { input_tokens: turn.in, output_tokens: turn.out, reasoning_tokens: turn.reasoning, cache_read: turn.cr, cache_write: turn.cw },
      };
      if (failed) result.result = friendlyError(errMsg || stderrTail.trim() || 'opencode exited with code ' + code);
      else if (interrupted) result.result = 'Interrupted';
      emit(result);
      nextTurn();
    });
    S.cancel = () => { interrupted = true; };
  }

  function nextTurn() {
    S.cancel = null;
    if (S.killed) return;
    const m = S.queue.shift();
    if (m) runTurn(m);
  }

  // Undo: keep the first `keepTurns` user turns (0 = empty conversation). Only legal between turns.
  // The adapter does not count turns itself: the authoritative list is read from OpenCode at call time, which is
  // also correct for resumed sessions (opts.resume) and matches the renderer's history count (one user message = one turn).
  async function rewind(keepTurns) {
    if (S.killed) return { ok: false, error: 'Session is closed' };
    if (S.child || S.queue.length || S.rewinding) return { ok: false, error: 'A turn is running; stop it before undoing' };
    if (!target) return { ok: false, error: 'OpenCode is not installed' };
    if (!S.sessionId) return { ok: true, filesReverted: 0, filesSkipped: 0 }; // nothing has been said yet
    S.rewinding = true;
    try { return await rewindOpencode(target, S.sessionId, keepTurns, cwd, opts.env); }
    finally { S.rewinding = false; nextTurn(); } // messages written during the rewind run now, on the truncated session
  }

  return {
    rewind,
    write(obj) {
      if (S.killed || !obj) return false;
      if (obj.type === 'user' && obj.message) {
        if (S.child || S.rewinding) S.queue.push(obj.message); else runTurn(obj.message);
        return true;
      }
      if (obj.type === 'control_request' && obj.request && obj.request.subtype === 'interrupt') {
        S.queue.length = 0;
        if (S.child) { if (S.cancel) S.cancel(); inst.killTree(S.child.pid); }
        return true;
      }
      return false; // control_response etc: OpenCode `run` has no permission round-trip
    },
    kill() {
      S.killed = true; S.queue.length = 0;
      if (S.child) inst.killTree(S.child.pid);
      cleanupTmp();
    },
  };
}

// Make the common failure modes readable.
function friendlyError(msg) {
  if (/no-route|unavailable|not found|ProviderModelNotFound/i.test(msg)) return msg + '\nThis model is unavailable. Pick another one, or sign in to the provider (Settings > OpenCode > Login).';
  if (/auth|credential|api key|unauthor|401|403|login/i.test(msg)) return msg + '\nNot signed in to this provider. Run "opencode auth login" (Settings > OpenCode > Login).';
  return msg;
}

// ------------------------------------------------------------------ service info
function parseCount(s) {
  const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([kKmMbB])?/);
  if (!m) return undefined;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}
function parseStats(raw) {
  const t = inst.stripAnsi(raw);
  const s = { raw: t.trim() };
  let m;
  if ((m = t.match(/([\d,.]+)\s+sessions?/i))) s.sessions = parseCount(m[1]);
  if ((m = t.match(/([\d,.]+)\s+prompts?/i))) s.prompts = parseCount(m[1]);
  if ((m = t.match(/([\d,.]+)\s+steps?/i))) s.steps = parseCount(m[1]);
  if ((m = t.match(/([\d,.]+\s*[kKmMbB]?)\s+tokens?/i))) s.tokens = parseCount(m[1]);
  if ((m = t.match(/\$\s*([\d,.]+)/))) s.cost = parseFloat(m[1].replace(/,/g, ''));
  if ((m = t.match(/([\d.]+)%\s+tool success/i))) s.toolSuccess = parseFloat(m[1]);
  return s;
}
function parseProviders(authText) {
  const out = new Set();
  for (const raw of inst.stripAnsi(authText).split('\n')) {
    let l = raw.trim().replace(/^[●•○◆◇*>-]+\s*/, '');
    if (!l || /^(no authenticated|credentials|environment|\d+\s+(credential|environment))/i.test(l) || /^[─-╿\s]+$/.test(l)) continue;
    const name = l.split(/\s{2,}|\s+(?=oauth\b|api\b|wellknown\b|env\b)/i)[0].trim();
    if (name && name.length < 40) out.add(name);
  }
  return out;
}

// NOTE: the long-running background service captures its environment when it starts, so provider API keys passed
// via `env` are only seen by a private server -> with a non-empty env we add --standalone to models/auth list.
async function service(custom, env) {
  const info = { installed: false, cmd: null, version: null, models: [], providers: [], stats: { raw: '' }, usage: { plan: 'local', windows: [] } };
  try {
    const target = resolveOpencode(custom);
    if (!target) return info;
    info.installed = true; info.cmd = target.shim || target.cmd;
    const extra = cleanEnv(env), hasEnv = Object.keys(extra).length > 0, fe = inst.freshEnv(extra);
    const run = (args, solo) => inst.exec(target, solo && hasEnv ? [...args, '--standalone'] : args, { timeout: SERVICE_TIMEOUT, env: fe }).catch(() => ({ code: -1, out: '', err: '' }));
    const [v, models, auth, stats] = await Promise.all([run(['--version']), run(['models'], true), run(['auth', 'list'], true), run(['stats'])]);
    info.version = inst.firstVersion(v.out);
    info.models = inst.stripAnsi(models.out).split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)).map((id) => {
      const [provider, ...rest] = id.split('/');
      return { id, provider, group: provider, label: rest.join('/'), free: provider === 'opencode' || /(:|-)free$/i.test(id) };
    });
    const provs = parseProviders(auth.out);
    for (const k of inst.opencodeAuthFileProviders()) provs.add(k);
    info.providers = [...provs];
    info.stats = parseStats(stats.out);
  } catch { /* best effort */ }
  return info;
}

// ------------------------------------------------------------------ session history
// Uses `opencode api GET /api/session[...]` (the v2 server API, all projects at once, not just the cwd's project).
// The background service answers in ~0.15s; if it fails we retry with a private --standalone server (~0.4s).
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function apiGet(target, pth, params, env, deadline) {
  const left = () => Math.max(1000, deadline - Date.now());
  for (const solo of [false, true]) {
    const args = ['api', ...(solo ? ['--standalone'] : []), 'GET', pth];
    for (const [k, v] of Object.entries(params || {})) args.push('--param', k + '=' + v);
    const r = await inst.exec(target, args, { timeout: left(), env });
    if (r.code === 0) { try { return JSON.parse(r.out); } catch { /* retry */ } }
    if (Date.now() >= deadline) break;
  }
  return null;
}
/** Follow cursor.next pages, de-duplicated by id (stops as soon as a page adds nothing new). */
async function apiPages(target, pth, env, deadline, max) {
  const all = [], seen = new Set(); let cursor = null;
  for (let i = 0; i < 20 && all.length < max; i++) {
    const j = await apiGet(target, pth, cursor ? { cursor } : {}, env, deadline);
    if (!j || !Array.isArray(j.data)) { if (!i) return null; break; }
    let fresh = 0;
    for (const x of j.data) if (x && x.id && !seen.has(x.id)) { seen.add(x.id); all.push(x); fresh++; }
    cursor = j.cursor && j.cursor.next;
    if (!fresh || !cursor) break;
  }
  return all;
}
const userText = (m) => String(m.text || '').trim();

async function listSessions(custom, opts) {
  opts = opts || {};
  try {
    const target = resolveOpencode(custom);
    if (!target) return [];
    const max = Math.min(opts.limit || 200, 500), deadline = Date.now() + 15000, env = inst.freshEnv(cleanEnv(opts.env));
    const rows = await apiPages(target, '/api/session', env, deadline, 1000);
    if (!rows) return [];
    const top = rows.filter((s) => !s.parentID) // sub-agent sessions belong to their parent
      .sort((a, b) => ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0)).slice(0, max);
    // sessions without an auto title: derive it from the first user message (bounded concurrency)
    const todo = top.filter((s) => !(s.title && s.title.trim())), titles = new Map();
    for (let i = 0; i < todo.length && Date.now() < deadline - 1500; i += 6) {
      await Promise.all(todo.slice(i, i + 6).map(async (s) => {
        const ms = await apiPages(target, `/api/session/${s.id}/message`, env, deadline, 2000);
        const first = (ms || []).filter((m) => m.type === 'user').sort((a, b) => ((a.time && a.time.created) || 0) - ((b.time && b.time.created) || 0))[0];
        if (first) titles.set(s.id, userText(first) || ((first.files || []).length ? '[attachment]' : ''));
      }));
    }
    return top.map((s) => ({
      id: s.id, title: clip(s.title, 120) || clip(titles.get(s.id), 120) || '(untitled)', cwd: (s.location && s.location.directory) || null,
      updatedAt: (s.time && s.time.updated) || 0, createdAt: (s.time && s.time.created) || undefined, provider: 'opencode',
      ...(s.model ? { model: (s.model.providerID ? s.model.providerID + '/' : '') + s.model.id } : {}),
    }));
  } catch { return []; }
}

async function readSession(custom, id, opts) {
  opts = opts || {};
  try {
    const target = resolveOpencode(custom);
    if (!target || !id) return [];
    const deadline = Date.now() + 25000, env = inst.freshEnv(cleanEnv(opts.env));
    const sess = await apiGet(target, '/api/session/' + encodeURIComponent(id), {}, env, deadline);
    const cwd = (sess && sess.data && sess.data.location && sess.data.location.directory) || opts.cwd || undefined;
    const msgs = await apiPages(target, `/api/session/${encodeURIComponent(id)}/message`, env, deadline, 5000);
    if (!msgs) return [];
    msgs.sort((a, b) => ((a.time && a.time.created) || 0) - ((b.time && b.time.created) || 0));
    const evs = [];
    for (const m of msgs) {
      if (m.type === 'user') {
        const content = [];
        for (const f of m.files || []) {
          if (f && f.data && /^image\//.test(f.mime || '')) content.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data } });
          else if (f && f.name) content.push({ type: 'text', text: '[attached: ' + f.name + ']' });
        }
        const t = userText(m); if (t) content.push({ type: 'text', text: t });
        if (content.length) evs.push({ type: 'user', message: { role: 'user', content } });
      } else if (m.type === 'assistant') {
        const blocks = [], results = [];
        for (const c of m.content || []) {
          if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text });
          else if (c.type === 'reasoning' && c.text && c.text.trim()) blocks.push({ type: 'thinking', thinking: c.text, signature: '' });
          else if (c.type === 'tool') {
            const st = c.state || {}, { name, input } = mapTool(c.name, st.input, cwd, st.title);
            blocks.push({ type: 'tool_use', id: c.id, name, input });
            if (st.status === 'completed' || st.status === 'error') {
              const err = st.status === 'error';
              const out = err ? (st.error && (st.error.message || st.error)) : Array.isArray(st.content) ? st.content.map((x) => (x && x.text) || '').filter(Boolean).join('\n') : (st.output != null ? st.output : '');
              results.push({ type: 'tool_result', tool_use_id: c.id, content: typeof out === 'string' ? out : JSON.stringify(out == null ? '' : out), is_error: err });
            }
          }
        }
        if (blocks.length) evs.push({ type: 'assistant', message: { id: m.id, type: 'message', role: 'assistant', content: blocks } });
        if (results.length) evs.push({ type: 'user', message: { role: 'user', content: results } });
      }
    }
    return evs.slice(-(opts.limit || 400));
  } catch { return []; }
}

// ------------------------------------------------------------------ undo / rewind
// OpenCode v2 has a two-step session revert: POST /api/session/{id}/revert/stage {messageID, files} hides that user message
// and everything after it (and, with files:true, restores the files changed since then from its git-based snapshot,
// returning the list of reverted files); POST .../revert/commit then deletes the hidden messages for good, so the next
// `opencode run --session` continues from the truncated history. Both go through a private --standalone server: it
// shares the on-disk database with the background service but has no stale in-memory state, and rejects (409) a busy session.
// Caveat: file restoration needs a git work tree (the snapshot lives in a shadow git repo); outside git only the
// conversation is rewound and the result carries a `note`.
async function apiSend(target, method, pth, body, env) {
  const args = ['api', '--standalone', method, pth];
  if (body) args.push('-d', JSON.stringify(body));
  const r = await inst.exec(target, args, { timeout: 60000, env });
  let json = null; try { json = r.out.trim() ? JSON.parse(r.out) : null; } catch { /* 204 / non-JSON */ }
  const msg = (json && json.message) || (r.err || r.out || '').trim().split('\n').pop() || '';
  return { ok: r.code === 0, json, error: msg };
}
const inGitTree = (dir) => { for (let d = dir, i = 0; d && i < 40; i++) { if (fs.existsSync(path.join(d, '.git'))) return true; const up = path.dirname(d); if (up === d) break; d = up; } return false; };
/** One renderer-visible user turn = one user message that has text or attachments (idle markers etc. are not turns). */
const userTurns = (msgs) => msgs.filter((m) => m && m.type === 'user' && (userText(m) || (m.files || []).length))
  .sort((a, b) => ((a.time && a.time.created) || 0) - ((b.time && b.time.created) || 0));

async function rewindOpencode(target, sessionId, keepTurns, cwd, envExtra) {
  try {
    keepTurns = Math.max(0, Math.floor(Number(keepTurns)));
    if (!Number.isFinite(keepTurns)) return { ok: false, error: 'keepTurns must be a number' };
    const env = inst.freshEnv(cleanEnv(envExtra)), deadline = Date.now() + 30000, id = encodeURIComponent(sessionId);
    const msgs = await apiPages(target, `/api/session/${id}/message`, env, deadline, 5000);
    if (!msgs) return { ok: false, error: 'Could not read the OpenCode session' };
    const users = userTurns(msgs);
    if (keepTurns >= users.length) return { ok: true, filesReverted: 0, filesSkipped: 0, note: 'Nothing to undo' };
    const st = await apiSend(target, 'POST', `/api/session/${id}/revert/stage`, { messageID: users[keepTurns].id, files: true }, env);
    if (!st.ok) return { ok: false, error: st.error || 'revert failed' };
    const files = (st.json && st.json.data && st.json.data.files) || [];
    const cm = await apiSend(target, 'POST', `/api/session/${id}/revert/commit`, null, env);
    if (!cm.ok) { await apiSend(target, 'DELETE', `/api/session/${id}/revert`, null, env); return { ok: false, error: cm.error || 'revert commit failed' }; }
    const res = { ok: true, filesReverted: files.length, filesSkipped: 0 };
    if (!files.length) {
      let loc = cwd;
      try { const s = await apiGet(target, `/api/session/${id}`, {}, env, deadline); loc = (s && s.data && s.data.location && s.data.location.directory) || cwd; } catch { /* keep cwd */ }
      if (loc && !inGitTree(loc)) res.note = 'Conversation rewound. File changes were not reverted: OpenCode only snapshots files inside a git repository (and needs git on PATH).';
    }
    return res;
  } catch (e) { return { ok: false, error: e.message }; }
}
/** Rewind a session that is not live (e.g. just opened from history). Same result shape as adapter.rewind(). */
async function rewindSession(custom, sessionId, keepTurns, opts) {
  opts = opts || {};
  const target = resolveOpencode(custom);
  if (!target) return { ok: false, error: 'OpenCode is not installed' };
  if (!sessionId) return { ok: false, error: 'No session id' };
  return rewindOpencode(target, sessionId, keepTurns, opts.cwd, opts.env);
}

// ------------------------------------------------------------------ login (interactive TUI -> visible console)
// opts.dryRun: just return the spawn arguments.
async function login(custom, opts = {}) {
  try {
    const target = resolveOpencode(custom);
    if (!target) return { ok: false, error: 'OpenCode is not installed' };
    const sub = opts.sub || 'auth login';
    // `start "title" cmd /k ""<bin>" auth login"` with verbatim args (the doubled outer quotes keep cmd from mangling paths with spaces)
    const args = ['/d', '/c', 'start', '"opencode login"', 'cmd', '/k', `""${target.cmd}" ${sub}"`];
    if (opts.dryRun) return { ok: true, command: 'cmd.exe ' + args.join(' ') };
    const c = spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, env: inst.freshEnv() });
    c.on('error', () => { });
    c.unref();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { start, service, resolveOpencode, login, mapTool, parseStats, listSessions, readSession, rewindSession };
